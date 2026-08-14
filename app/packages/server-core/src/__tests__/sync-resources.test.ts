import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakePostgres } from "./helpers/fake-postgres";

/**
 * sync-resources orchestrates listing resources from a plugin client and
 * reconciling them into the DB + ClickHouse. We mock every external dep:
 *
 *  - db: real Drizzle over a recording driver (helpers/fake-postgres.ts).
 *    Result rows are queued FIFO in statement order — writes consume a queue
 *    slot too, so a queued `[]` marks each write between two reads that need
 *    rows; anything past the queue resolves to the empty default. A full
 *    account sync issues: account select, prior-snapshot select, one upsert
 *    per fetched resource, a change-timeline insert (when there are events),
 *    the soft-delete update, the pinned selectDistinct, then the refs select.
 *  - encryption, plugin-loader, host-services, tunnel-resolver: vi.fn mocks.
 *  - clickhouse/writers: vi.fn mocks asserting the streamed rows.
 *  - plugin-base: only `evaluatePeerIntegrationUnreachable` is used.
 */

const pg = fakePostgres();
vi.mock("../db/client", () => ({ db: pg.db }));

/** Captured writes by rendered table name, replacing the old stub recorders. */
const inserts = (table: string) =>
  pg.queries.filter((q) => q.sql.startsWith(`insert into "${table}"`));
const updates = (table?: string) =>
  pg.queries.filter((q) => q.sql.startsWith(table ? `update "${table}"` : "update "));

// --- encryption ------------------------------------------------------------
const decrypt = vi.fn(async (_ct: string) => JSON.stringify({ token: "secret" }));
const encrypt = vi.fn(async () => ({ ciphertext: "CT", iv: "IV" }));
vi.mock("../encryption", () => ({
  decrypt,
  encrypt,
  buildAad: (...p: string[]) => p.join(":"),
}));

// --- plugin loader / host services / tunnel --------------------------------
const getPlugin = vi.fn();
vi.mock("../plugin-loader", () => ({ getPlugin }));
const buildPluginHostServices = vi.fn(async () => ({}) as Record<string, unknown>);
vi.mock("../host-services", () => ({ buildPluginHostServices }));
const rewriteCredentialsThroughTunnel = vi.fn(async () => undefined);
vi.mock("../tunnel-resolver", () => ({ rewriteCredentialsThroughTunnel }));

// --- clickhouse writers ----------------------------------------------------
const flattenMetricSeries = vi.fn(() => [{ metric: "cpu" }]);
const insertAccountResourceCounts = vi.fn(async (_opts?: unknown) => undefined);
const insertDashboardStats = vi.fn(async () => undefined);
const insertMetricPoints = vi.fn(async () => undefined);
const insertPollOutcome = vi.fn(async () => undefined);
vi.mock("../clickhouse/writers", () => ({
  flattenMetricSeries,
  insertAccountResourceCounts,
  insertDashboardStats,
  insertMetricPoints,
  insertPollOutcome,
}));

// --- plugin-base -----------------------------------------------------------
const evaluatePeerIntegrationUnreachable = vi.fn(() => false);
vi.mock("@infrawrench/plugin-base", () => ({ evaluatePeerIntegrationUnreachable }));

let sync: typeof import("../sync-resources");

// Helpers ------------------------------------------------------------------
function resourceInstance(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "res-1",
    pluginId: "aws",
    resourceTypeId: "vm",
    displayName: "VM 1",
    fields: { region: "us" },
    resolvedOutputs: { ip: "1.2.3.4" },
    ...over,
  };
}

function fakePlugin(over: Partial<Record<string, unknown>> = {}) {
  return {
    manifest: { id: "aws" },
    resourceTypes: [{ id: "vm", pluralDisplayName: "VMs" }],
    createClient: vi.fn(() => makeClient()),
    ...over,
  };
}

function makeClient(over: Partial<Record<string, unknown>> = {}) {
  return {
    listResources: vi.fn(async () => [resourceInstance()]),
    getResource: vi.fn(async () => resourceInstance()),
    resolveOutput: vi.fn(async () => "1.2.3.4"),
    updateResource: vi.fn(async () => resourceInstance({ displayName: "VM updated" })),
    ...over,
  };
}

// Keys in `accounts` column order — the lookup selects the whole row.
function accountRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "acc-1",
    organizationId: "org-1",
    pluginId: "aws",
    displayName: "Prod",
    encryptedCredentials: "ENC",
    credentialsIv: "IV",
    bastionId: null,
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  pg.reset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  decrypt.mockResolvedValue(JSON.stringify({ token: "secret" }));
  evaluatePeerIntegrationUnreachable.mockReturnValue(false);
  getPlugin.mockResolvedValue({ plugin: fakePlugin() });
  sync = await import("../sync-resources");
});

// --- syncAccountResourceType ----------------------------------------------
describe("syncAccountResourceType", () => {
  it("throws when the account is not found", async () => {
    pg.queueRows([]); // loadAccountClient -> account lookup empty
    await expect(sync.syncAccountResourceType("acc-1", "org-1", "vm")).rejects.toThrow(
      /Account not found/,
    );
  });

  it("throws when the plugin is not loaded", async () => {
    pg.queueRows([accountRow()]); // account
    getPlugin.mockResolvedValue(null);
    await expect(sync.syncAccountResourceType("acc-1", "org-1", "vm")).rejects.toThrow(
      /not loaded/,
    );
  });

  it("throws when the resource type is unknown", async () => {
    pg.queueRows([accountRow()]);
    await expect(sync.syncAccountResourceType("acc-1", "org-1", "nope")).rejects.toThrow(
      /Resource type "nope" not found/,
    );
  });

  it("upserts fetched resources and soft-deletes the rest", async () => {
    pg.queueRows([accountRow()]); // account
    // Change-timeline prior snapshots, upsert, change insert and soft-delete
    // all resolve to the empty default.
    const client = makeClient({ listResources: vi.fn(async () => [resourceInstance()]) });
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({ createClient: vi.fn(() => client) }),
    });
    const out = await sync.syncAccountResourceType("acc-1", "org-1", "vm");
    expect(out).toHaveLength(1);
    // one upsert (insert ... on conflict do update) + a soft-delete update
    expect(inserts("resources")).toHaveLength(1);
    expect(inserts("resources")[0]!.sql).toContain("on conflict");
    expect(updates("resources")).toHaveLength(1);
    expect(rewriteCredentialsThroughTunnel).toHaveBeenCalledWith("acc-1", { token: "secret" });
  });

  it("still issues the soft-delete update when nothing is live", async () => {
    pg.queueRows([accountRow()]);
    const client = makeClient({ listResources: vi.fn(async () => []) });
    getPlugin.mockResolvedValue({ plugin: fakePlugin({ createClient: vi.fn(() => client) }) });
    const out = await sync.syncAccountResourceType("acc-1", "org-1", "vm");
    expect(out).toHaveLength(0);
    expect(updates("resources")).toHaveLength(1);
  });
});

// --- syncAccountResources --------------------------------------------------
describe("syncAccountResources", () => {
  it("syncs all types, records counts, and writes a poll outcome", async () => {
    pg.queueRows([accountRow()]); // loadAccountClient
    // prior snapshots, pinned, and refs all resolve to the empty default.
    const client = makeClient();
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({
        resourceTypes: [{ id: "vm", pluralDisplayName: "VMs" }],
        createClient: vi.fn(() => client),
      }),
    });
    const out = await sync.syncAccountResources("acc-1", "org-1");
    expect(out.resourceCount).toBe(1);
    expect(out.succeededTypeIds).toEqual(["vm"]);
    expect(out.failedTypeIds).toEqual([]);
    expect(insertPollOutcome).toHaveBeenCalledTimes(1);
  });

  it("honors canListType skipping and fires onTypeDone callbacks", async () => {
    pg.queueRows([accountRow()]);
    const client = makeClient();
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({
        resourceTypes: [
          { id: "vm", pluralDisplayName: "VMs" },
          { id: "db", pluralDisplayName: "DBs" },
        ],
        createClient: vi.fn(() => client),
      }),
    });
    const onTypeDone = vi.fn();
    const out = await sync.syncAccountResources("acc-1", "org-1", {
      canListType: (id) => id !== "db",
      onTypeDone,
    });
    expect(out.skippedTypeIds).toEqual(["db"]);
    expect(out.succeededTypeIds).toEqual(["vm"]);
    expect(onTypeDone).toHaveBeenCalledWith("db", "skipped");
    expect(onTypeDone).toHaveBeenCalledWith("vm", "ok");
  });

  it("records a type failure without aborting and surfaces firstError", async () => {
    pg.queueRows([accountRow()]);
    const client = makeClient({
      listResources: vi.fn(async (typeId: string) => {
        if (typeId === "db") throw new Error("api 500");
        return [resourceInstance()];
      }),
    });
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({
        resourceTypes: [
          { id: "vm", pluralDisplayName: "VMs" },
          { id: "db", pluralDisplayName: "DBs" },
        ],
        createClient: vi.fn(() => client),
      }),
    });
    const onTypeDone = vi.fn();
    const out = await sync.syncAccountResources("acc-1", "org-1", { onTypeDone });
    expect(out.failedTypeIds).toEqual(["db"]);
    expect(out.firstError?.message).toBe("api 500");
    expect(onTypeDone).toHaveBeenCalledWith("db", "error", expect.any(Error));
  });

  it("coerces a non-Error rejection into an Error", async () => {
    pg.queueRows([accountRow()]);
    const client = makeClient({
      listResources: vi.fn(async () => {
        throw "string failure";
      }),
    });
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({ createClient: vi.fn(() => client) }),
    });
    const out = await sync.syncAccountResources("acc-1", "org-1");
    expect(out.firstError).toBeInstanceOf(Error);
    expect(out.firstError?.message).toBe("string failure");
  });

  it("swallows reconcile errors so the poll cycle still completes", async () => {
    pg.queueRows([accountRow()]); // loadAccountClient (db.select #1)
    // db.select #2 is the change-timeline prior-snapshot load.
    // refreshPinnedStats pinned uses db.selectDistinct (no select).
    // reconcileAccountReferences refs is db.select #3 -> throw.
    const orig = pg.db.select;
    let calls = 0;
    (pg.db as { select: typeof pg.db.select }).select = ((...args: never[]) => {
      calls++;
      if (calls === 3) throw new Error("reconcile boom");
      return (orig as (...a: never[]) => ReturnType<typeof orig>).apply(pg.db, args);
    }) as typeof pg.db.select;
    try {
      const out = await sync.syncAccountResources("acc-1", "org-1");
      expect(out.resourceCount).toBe(1);
      expect(console.error).toHaveBeenCalledWith(
        "[sync] reconcileAccountReferences failed:",
        expect.any(Error),
      );
    } finally {
      (pg.db as { select: typeof pg.db.select }).select = orig;
    }
  });
});

// --- refreshPinnedStats (exercised via syncAccountResources) ---------------
describe("refreshPinnedStats", () => {
  /**
   * Queue everything up to the pinned read for a one-resource sync: account
   * lookup, prior snapshots, the upsert, the change-timeline insert and the
   * soft-delete update (writes hold a queue slot too), then the pins.
   * Keys in the pinned projection order. The refs read takes the default.
   */
  function queueSyncWithPins(pinned: Array<Record<string, unknown>>) {
    pg.queueRows([accountRow()]); // loadAccountClient
    pg.queueRows([]); // prior snapshots
    pg.queueRows([]); // upsert
    pg.queueRows([]); // change-timeline insert
    pg.queueRows([]); // soft-delete update
    pg.queueRows(pinned); // dashboard pins
  }

  it("writes aggregate counts for an __account__ pin", async () => {
    queueSyncWithPins([{ resourceId: "r", resourceTypeId: "__account__", pluginId: "aws" }]);
    const out = await sync.syncAccountResources("acc-1", "org-1");
    expect(insertAccountResourceCounts).toHaveBeenCalledTimes(1);
    const arg = insertAccountResourceCounts.mock.calls[0]![0] as { counts: unknown[] };
    expect(arg.counts).toEqual([{ typeLabel: "VMs", count: 1 }]);
    expect(out.resourceCount).toBe(1);
  });

  it("fetches dashboard stats and metrics for a pinned resource", async () => {
    queueSyncWithPins([{ resourceId: "r1", resourceTypeId: "vm", pluginId: "aws" }]);
    const fetchDashboardStats = vi.fn(async () => [{ label: "CPU", value: 1 }]);
    const fetchMetricSeries = vi.fn(async () => [{ label: "cpu", points: [] }]);
    const client = makeClient({ fetchDashboardStats, fetchMetricSeries });
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({
        resourceTypes: [{ id: "vm", pluralDisplayName: "VMs", supportsMetrics: true }],
        createClient: vi.fn(() => client),
      }),
    });
    await sync.syncAccountResources("acc-1", "org-1");
    expect(insertDashboardStats).toHaveBeenCalledTimes(1);
    expect(insertMetricPoints).toHaveBeenCalledTimes(1);
    expect(flattenMetricSeries).toHaveBeenCalled();
  });

  it("skips stats entirely when the client has no fetchDashboardStats", async () => {
    queueSyncWithPins([{ resourceId: "r1", resourceTypeId: "vm", pluginId: "aws" }]);
    const client = makeClient(); // no fetchDashboardStats
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({ createClient: vi.fn(() => client) }),
    });
    await sync.syncAccountResources("acc-1", "org-1");
    expect(insertDashboardStats).not.toHaveBeenCalled();
  });

  it("swallows a per-resource stats failure", async () => {
    queueSyncWithPins([{ resourceId: "r1", resourceTypeId: "vm", pluginId: "aws" }]);
    const fetchDashboardStats = vi.fn(async () => {
      throw new Error("stats down");
    });
    const client = makeClient({ fetchDashboardStats });
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({ createClient: vi.fn(() => client) }),
    });
    await expect(sync.syncAccountResources("acc-1", "org-1")).resolves.toBeDefined();
    expect(insertDashboardStats).not.toHaveBeenCalled();
  });

  it("collects peer metric series when a type exposes metrics to parent", async () => {
    queueSyncWithPins([{ resourceId: "r1", resourceTypeId: "vm", pluginId: "aws" }]);
    const parentClient = makeClient({
      fetchDashboardStats: vi.fn(async () => [{ label: "x", value: 1 }]),
      getResource: vi.fn(async () => resourceInstance()),
      resolveOutput: vi.fn(async () => "peer-cred"),
    });
    const fetchMetricSeriesMock = vi.fn(async () => [{ label: "lat", points: [] }]);
    const peerClient = makeClient({
      fetchMetricSeries: fetchMetricSeriesMock,
    });
    const parentPlugin = fakePlugin({
      resourceTypes: [
        {
          id: "vm",
          pluralDisplayName: "VMs",
          peerIntegrations: [
            {
              pluginId: "peer",
              tabLabel: "Peer",
              exposeMetricsToParent: true,
              credentialMappings: [{ credentialKey: "url", outputKey: "endpoint" }],
            },
          ],
        },
      ],
      createClient: vi.fn(() => parentClient),
    });
    getPlugin.mockImplementation(async (id: string) => {
      if (id === "peer") {
        return { plugin: fakePlugin({ createClient: vi.fn(() => peerClient) }) };
      }
      return { plugin: parentPlugin };
    });
    await sync.syncAccountResources("acc-1", "org-1");
    expect(fetchMetricSeriesMock).toHaveBeenCalled();
    expect(insertMetricPoints).toHaveBeenCalled();
  });

  it("skips an unreachable peer integration", async () => {
    queueSyncWithPins([{ resourceId: "r1", resourceTypeId: "vm", pluginId: "aws" }]);
    evaluatePeerIntegrationUnreachable.mockReturnValue(true);
    const parentClient = makeClient({
      fetchDashboardStats: vi.fn(async () => [{ label: "x", value: 1 }]),
    });
    const parentPlugin = fakePlugin({
      resourceTypes: [
        {
          id: "vm",
          pluralDisplayName: "VMs",
          peerIntegrations: [
            {
              pluginId: "peer",
              tabLabel: "Peer",
              exposeMetricsToParent: true,
              credentialMappings: [],
            },
          ],
        },
      ],
      createClient: vi.fn(() => parentClient),
    });
    getPlugin.mockResolvedValue({ plugin: parentPlugin });
    await sync.syncAccountResources("acc-1", "org-1");
    // No peer metrics; insertMetricPoints not called since stats produce no series.
    expect(insertMetricPoints).not.toHaveBeenCalled();
  });
});

// --- reconcileAccountReferences --------------------------------------------
describe("reconcileAccountReferences", () => {
  function refRow(over: Partial<Record<string, unknown>> = {}) {
    return {
      consumerId: "cons-1",
      consumerPluginId: "cloudflare",
      consumerTypeId: "dns-record",
      consumerAccountId: "acc-cf",
      fieldKey: "content",
      sourcePluginId: "aws",
      sourceTypeId: "vm",
      sourceResourceId: "src-1",
      sourceAccountId: "acc-aws",
      sourceOutputKey: "ip",
      cachedEncryptedValue: null,
      cachedValueIv: null,
      ...over,
    };
  }

  it("returns early when there are no references", async () => {
    pg.queueRows([]); // refs query
    await expect(sync.reconcileAccountReferences("acc-1", "org-1")).resolves.toBeUndefined();
    expect(updates()).toHaveLength(0);
  });

  it("skips references missing required source fields", async () => {
    pg.queueRows([refRow({ sourceAccountId: null })]);
    await sync.reconcileAccountReferences("acc-1", "org-1");
    // No source client load, no update.
    expect(updates()).toHaveLength(0);
  });

  it("pushes a changed value to the consumer and refreshes the cache", async () => {
    pg.queueRows([refRow()]); // refs
    pg.queueRows([accountRow({ id: "acc-aws", pluginId: "aws" })]); // source loadAccountClient
    pg.queueRows([accountRow({ id: "acc-cf", pluginId: "cloudflare" })]); // consumer loadAccountClient
    const sourceClient = makeClient({ resolveOutput: vi.fn(async () => "9.9.9.9") });
    const consumerClient = makeClient({
      updateResource: vi.fn(async () => resourceInstance({ id: "cons-1" })),
    });
    let call = 0;
    getPlugin.mockImplementation(async () => {
      call++;
      return {
        plugin: fakePlugin({
          createClient: vi.fn(() => (call === 1 ? sourceClient : consumerClient)),
        }),
      };
    });
    await sync.reconcileAccountReferences("acc-1", "org-1");
    expect(consumerClient.updateResource).toHaveBeenCalledWith("dns-record", "cons-1", "acc-cf", {
      content: "9.9.9.9",
    });
    // cache refresh update on secret_field_states
    expect(updates("secret_field_states")).toHaveLength(1);
    expect(encrypt).toHaveBeenCalled();
  });

  it("skips when the resolved value is unchanged from the decrypted cache", async () => {
    pg.queueRows([refRow({ cachedEncryptedValue: "OLD", cachedValueIv: "IV" })]);
    pg.queueRows([accountRow({ id: "acc-aws" })]); // source
    decrypt.mockImplementation(async (ct: string) => {
      if (ct === "OLD") return "9.9.9.9";
      return JSON.stringify({ token: "secret" });
    });
    const sourceClient = makeClient({ resolveOutput: vi.fn(async () => "9.9.9.9") });
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({ createClient: vi.fn(() => sourceClient) }),
    });
    await sync.reconcileAccountReferences("acc-1", "org-1");
    expect(updates()).toHaveLength(0);
  });

  it("skips when the resolved value is empty", async () => {
    pg.queueRows([refRow()]);
    pg.queueRows([accountRow({ id: "acc-aws" })]); // source
    const sourceClient = makeClient({ resolveOutput: vi.fn(async () => "") });
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({ createClient: vi.fn(() => sourceClient) }),
    });
    await sync.reconcileAccountReferences("acc-1", "org-1");
    expect(updates()).toHaveLength(0);
  });

  it("skips when the source client cannot be loaded", async () => {
    pg.queueRows([refRow()]);
    pg.queueRows([]); // source account not found -> loadAccountClient throws -> cached null
    await sync.reconcileAccountReferences("acc-1", "org-1");
    expect(updates()).toHaveLength(0);
  });

  it("skips when the consumer plugin has no updateResource", async () => {
    pg.queueRows([refRow()]);
    pg.queueRows([accountRow({ id: "acc-aws" })]); // source
    pg.queueRows([accountRow({ id: "acc-cf" })]); // consumer
    const sourceClient = makeClient({ resolveOutput: vi.fn(async () => "9.9.9.9") });
    const consumerClient = makeClient({ updateResource: undefined });
    let call = 0;
    getPlugin.mockImplementation(async () => {
      call++;
      return {
        plugin: fakePlugin({
          createClient: vi.fn(() => (call === 1 ? sourceClient : consumerClient)),
        }),
      };
    });
    await sync.reconcileAccountReferences("acc-1", "org-1");
    expect(updates()).toHaveLength(0);
  });

  it("treats an undecryptable cache as a cache miss (pushes the value)", async () => {
    pg.queueRows([refRow({ cachedEncryptedValue: "BAD", cachedValueIv: "IV" })]);
    pg.queueRows([accountRow({ id: "acc-aws" })]); // source
    pg.queueRows([accountRow({ id: "acc-cf" })]); // consumer
    decrypt.mockImplementation(async (ct: string) => {
      if (ct === "BAD") throw new Error("cannot decrypt cache");
      return JSON.stringify({ token: "secret" });
    });
    const sourceClient = makeClient({ resolveOutput: vi.fn(async () => "9.9.9.9") });
    const consumerClient = makeClient();
    let call = 0;
    getPlugin.mockImplementation(async () => {
      call++;
      return {
        plugin: fakePlugin({
          createClient: vi.fn(() => (call === 1 ? sourceClient : consumerClient)),
        }),
      };
    });
    await sync.reconcileAccountReferences("acc-1", "org-1");
    expect(consumerClient.updateResource).toHaveBeenCalled();
  });

  it("swallows per-reference errors and continues", async () => {
    pg.queueRows([refRow()]);
    pg.queueRows([accountRow({ id: "acc-aws" })]); // source
    const sourceClient = makeClient({
      resolveOutput: vi.fn(async () => {
        throw new Error("resolve boom");
      }),
    });
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({ createClient: vi.fn(() => sourceClient) }),
    });
    await expect(sync.reconcileAccountReferences("acc-1", "org-1")).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
