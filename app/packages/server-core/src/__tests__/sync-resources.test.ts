import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * sync-resources orchestrates listing resources from a plugin client and
 * reconciling them into the DB + ClickHouse. We mock every external dep:
 *
 *  - db: a flexible chainable fake. Every builder method returns the same
 *    chainable object, which is also a thenable resolving to a queued result
 *    set. `select()`/`selectDistinct()` pull from `selectQueue`; writes are
 *    recorded.
 *  - encryption, plugin-loader, host-services, tunnel-resolver: vi.fn mocks.
 *  - clickhouse/writers: vi.fn mocks asserting the streamed rows.
 *  - plugin-base: only `evaluatePeerIntegrationUnreachable` is used.
 */

// --- DB chainable fake -----------------------------------------------------
const selectQueue: unknown[][] = [];
const writes: Array<{ kind: string; arg?: unknown }> = [];

function makeChain() {
  // The object is both a query builder and a thenable.
  const rows = selectQueue.shift() ?? [];
  const chain: Record<string, unknown> = {};
  const passthrough = ["from", "where", "innerJoin", "leftJoin", "limit", "orderBy", "groupBy"];
  for (const m of passthrough) {
    chain[m] = () => chain;
  }
  // thenable so `await db.select()...` resolves to rows
  chain["then"] = (resolve: (v: unknown[]) => unknown) => resolve(rows);
  return chain;
}

const db = {
  select: vi.fn(() => makeChain()),
  selectDistinct: vi.fn(() => makeChain()),
  insert: vi.fn(() => ({
    values: (v: unknown) => {
      writes.push({ kind: "insert", arg: v });
      return {
        onConflictDoUpdate: () => {
          writes.push({ kind: "onConflictDoUpdate" });
          return Promise.resolve();
        },
        onConflictDoNothing: () => Promise.resolve(),
      };
    },
  })),
  update: vi.fn(() => ({
    set: (s: unknown) => {
      writes.push({ kind: "update", arg: s });
      return { where: () => Promise.resolve() };
    },
  })),
  delete: vi.fn(() => ({ where: () => Promise.resolve() })),
};
vi.mock("../db/client", () => ({ db }));
vi.mock("../db/schema", () => ({
  accounts: { id: "id", organizationId: "organizationId", bastionId: "bastionId" },
  dashboardPins: { resourceId: "resourceId", deletedAt: "deletedAt" },
  resources: {
    id: "id",
    organizationId: "organizationId",
    pluginId: "pluginId",
    resourceTypeId: "resourceTypeId",
    accountId: "accountId",
    deletedAt: "deletedAt",
    lastSyncedAt: "lastSyncedAt",
    fieldsJson: "fieldsJson",
    outputsJson: "outputsJson",
  },
  secretFieldStates: {
    resourceId: "resourceId",
    fieldKey: "fieldKey",
    sourcePluginId: "sourcePluginId",
    sourceResourceTypeId: "sourceResourceTypeId",
    sourceResourceId: "sourceResourceId",
    sourceAccountId: "sourceAccountId",
    sourceOutputKey: "sourceOutputKey",
    cachedEncryptedValue: "cachedEncryptedValue",
    cachedValueIv: "cachedValueIv",
    resolutionKind: "resolutionKind",
  },
}));

// --- encryption ------------------------------------------------------------
const decrypt = vi.fn(async () => JSON.stringify({ token: "secret" }));
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
const insertAccountResourceCounts = vi.fn(async () => undefined);
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

function accountRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "acc-1",
    organizationId: "org-1",
    pluginId: "aws",
    encryptedCredentials: "ENC",
    credentialsIv: "IV",
    bastionId: null,
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  writes.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  db.select.mockImplementation(() => makeChain());
  db.selectDistinct.mockImplementation(() => makeChain());
  decrypt.mockResolvedValue(JSON.stringify({ token: "secret" }));
  evaluatePeerIntegrationUnreachable.mockReturnValue(false);
  getPlugin.mockResolvedValue({ plugin: fakePlugin() });
  sync = await import("../sync-resources");
});

// --- syncAccountResourceType ----------------------------------------------
describe("syncAccountResourceType", () => {
  it("throws when the account is not found", async () => {
    selectQueue.push([]); // loadAccountClient -> account lookup empty
    await expect(sync.syncAccountResourceType("acc-1", "org-1", "vm")).rejects.toThrow(
      /Account not found/,
    );
  });

  it("throws when the plugin is not loaded", async () => {
    selectQueue.push([accountRow()]); // account
    getPlugin.mockResolvedValue(null);
    await expect(sync.syncAccountResourceType("acc-1", "org-1", "vm")).rejects.toThrow(
      /not loaded/,
    );
  });

  it("throws when the resource type is unknown", async () => {
    selectQueue.push([accountRow()]);
    await expect(sync.syncAccountResourceType("acc-1", "org-1", "nope")).rejects.toThrow(
      /Resource type "nope" not found/,
    );
  });

  it("upserts fetched resources and soft-deletes the rest", async () => {
    selectQueue.push([accountRow()]); // account
    const client = makeClient({ listResources: vi.fn(async () => [resourceInstance()]) });
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({ createClient: vi.fn(() => client) }),
    });
    const out = await sync.syncAccountResourceType("acc-1", "org-1", "vm");
    expect(out).toHaveLength(1);
    // one upsert (insert + onConflictDoUpdate) + a soft-delete update
    expect(writes.some((w) => w.kind === "insert")).toBe(true);
    expect(db.update).toHaveBeenCalled();
    expect(rewriteCredentialsThroughTunnel).toHaveBeenCalledWith("acc-1", { token: "secret" });
  });

  it("still issues the soft-delete update when nothing is live", async () => {
    selectQueue.push([accountRow()]);
    const client = makeClient({ listResources: vi.fn(async () => []) });
    getPlugin.mockResolvedValue({ plugin: fakePlugin({ createClient: vi.fn(() => client) }) });
    const out = await sync.syncAccountResourceType("acc-1", "org-1", "vm");
    expect(out).toHaveLength(0);
    expect(db.update).toHaveBeenCalled();
  });
});

// --- syncAccountResources --------------------------------------------------
describe("syncAccountResources", () => {
  it("syncs all types, records counts, and writes a poll outcome", async () => {
    selectQueue.push([accountRow()]); // loadAccountClient
    selectQueue.push([]); // refreshPinnedStats -> pinned (none)
    selectQueue.push([]); // reconcileAccountReferences -> refs (none)
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
    selectQueue.push([accountRow()]);
    selectQueue.push([]); // pinned
    selectQueue.push([]); // refs
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
    selectQueue.push([accountRow()]);
    selectQueue.push([]); // pinned
    selectQueue.push([]); // refs
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
    selectQueue.push([accountRow()]);
    selectQueue.push([]);
    selectQueue.push([]);
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
    selectQueue.push([accountRow()]); // loadAccountClient (db.select #1)
    // refreshPinnedStats pinned uses db.selectDistinct (no select).
    // reconcileAccountReferences refs is db.select #2 -> throw.
    let calls = 0;
    db.select.mockImplementation(() => {
      calls++;
      if (calls === 2) throw new Error("reconcile boom");
      return makeChain();
    });
    const out = await sync.syncAccountResources("acc-1", "org-1");
    expect(out.resourceCount).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      "[sync] reconcileAccountReferences failed:",
      expect.any(Error),
    );
  });
});

// --- refreshPinnedStats (exercised via syncAccountResources) ---------------
describe("refreshPinnedStats", () => {
  it("writes aggregate counts for an __account__ pin", async () => {
    selectQueue.push([accountRow()]); // loadAccountClient
    selectQueue.push([{ resourceId: "r", resourceTypeId: "__account__", pluginId: "aws" }]); // pinned
    selectQueue.push([]); // refs
    const out = await sync.syncAccountResources("acc-1", "org-1");
    expect(insertAccountResourceCounts).toHaveBeenCalledTimes(1);
    const arg = insertAccountResourceCounts.mock.calls[0]![0] as { counts: unknown[] };
    expect(arg.counts).toEqual([{ typeLabel: "VMs", count: 1 }]);
    expect(out.resourceCount).toBe(1);
  });

  it("fetches dashboard stats and metrics for a pinned resource", async () => {
    selectQueue.push([accountRow()]); // loadAccountClient
    selectQueue.push([{ resourceId: "r1", resourceTypeId: "vm", pluginId: "aws" }]); // pinned
    selectQueue.push([]); // refs
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
    selectQueue.push([accountRow()]);
    selectQueue.push([{ resourceId: "r1", resourceTypeId: "vm", pluginId: "aws" }]); // pinned
    selectQueue.push([]); // refs
    const client = makeClient(); // no fetchDashboardStats
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({ createClient: vi.fn(() => client) }),
    });
    await sync.syncAccountResources("acc-1", "org-1");
    expect(insertDashboardStats).not.toHaveBeenCalled();
  });

  it("swallows a per-resource stats failure", async () => {
    selectQueue.push([accountRow()]);
    selectQueue.push([{ resourceId: "r1", resourceTypeId: "vm", pluginId: "aws" }]); // pinned
    selectQueue.push([]); // refs
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
    selectQueue.push([accountRow()]); // parent loadAccountClient
    selectQueue.push([{ resourceId: "r1", resourceTypeId: "vm", pluginId: "aws" }]); // pinned
    selectQueue.push([]); // refs
    const parentClient = makeClient({
      fetchDashboardStats: vi.fn(async () => [{ label: "x", value: 1 }]),
      getResource: vi.fn(async () => resourceInstance()),
      resolveOutput: vi.fn(async () => "peer-cred"),
    });
    const peerClient = makeClient({
      fetchMetricSeries: vi.fn(async () => [{ label: "lat", points: [] }]),
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
    expect(peerClient.fetchMetricSeries).toHaveBeenCalled();
    expect(insertMetricPoints).toHaveBeenCalled();
  });

  it("skips an unreachable peer integration", async () => {
    selectQueue.push([accountRow()]);
    selectQueue.push([{ resourceId: "r1", resourceTypeId: "vm", pluginId: "aws" }]); // pinned
    selectQueue.push([]); // refs
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
    selectQueue.push([]); // refs query
    await expect(sync.reconcileAccountReferences("acc-1", "org-1")).resolves.toBeUndefined();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("skips references missing required source fields", async () => {
    selectQueue.push([refRow({ sourceAccountId: null })]);
    await sync.reconcileAccountReferences("acc-1", "org-1");
    // No source client load, no update.
    expect(db.update).not.toHaveBeenCalled();
  });

  it("pushes a changed value to the consumer and refreshes the cache", async () => {
    selectQueue.push([refRow()]); // refs
    selectQueue.push([accountRow({ id: "acc-aws", pluginId: "aws" })]); // source loadAccountClient
    selectQueue.push([accountRow({ id: "acc-cf", pluginId: "cloudflare" })]); // consumer loadAccountClient
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
    // cache refresh update on secretFieldStates
    expect(db.update).toHaveBeenCalled();
    expect(encrypt).toHaveBeenCalled();
  });

  it("skips when the resolved value is unchanged from the decrypted cache", async () => {
    selectQueue.push([refRow({ cachedEncryptedValue: "OLD", cachedValueIv: "IV" })]);
    selectQueue.push([accountRow({ id: "acc-aws" })]); // source
    decrypt.mockImplementation(async (ct: string) => {
      if (ct === "OLD") return "9.9.9.9";
      return JSON.stringify({ token: "secret" });
    });
    const sourceClient = makeClient({ resolveOutput: vi.fn(async () => "9.9.9.9") });
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({ createClient: vi.fn(() => sourceClient) }),
    });
    await sync.reconcileAccountReferences("acc-1", "org-1");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("skips when the resolved value is empty", async () => {
    selectQueue.push([refRow()]);
    selectQueue.push([accountRow({ id: "acc-aws" })]); // source
    const sourceClient = makeClient({ resolveOutput: vi.fn(async () => "") });
    getPlugin.mockResolvedValue({
      plugin: fakePlugin({ createClient: vi.fn(() => sourceClient) }),
    });
    await sync.reconcileAccountReferences("acc-1", "org-1");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("skips when the source client cannot be loaded", async () => {
    selectQueue.push([refRow()]);
    selectQueue.push([]); // source account not found -> loadAccountClient throws -> cached null
    await sync.reconcileAccountReferences("acc-1", "org-1");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("skips when the consumer plugin has no updateResource", async () => {
    selectQueue.push([refRow()]);
    selectQueue.push([accountRow({ id: "acc-aws" })]); // source
    selectQueue.push([accountRow({ id: "acc-cf" })]); // consumer
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
    expect(db.update).not.toHaveBeenCalled();
  });

  it("treats an undecryptable cache as a cache miss (pushes the value)", async () => {
    selectQueue.push([refRow({ cachedEncryptedValue: "BAD", cachedValueIv: "IV" })]);
    selectQueue.push([accountRow({ id: "acc-aws" })]); // source
    selectQueue.push([accountRow({ id: "acc-cf" })]); // consumer
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
    selectQueue.push([refRow()]);
    selectQueue.push([accountRow({ id: "acc-aws" })]); // source
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
