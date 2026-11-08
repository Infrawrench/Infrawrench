/**
 * The read-only local feature operations over Effect RPC, end to end: the
 * renderer's client calls the main process's real server and handlers, which
 * run the real scans over fixture rows (the database getter, plugin loader
 * and live listing are the only fakes), so every answer is encoded and decoded
 * against its schema exactly as in the app.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  interface Dismissal {
    resource_id: string;
    rule_id: string;
    reason: string | null;
    updated_at: string;
  }
  interface State {
    userData: string;
    dbError: Error | null;
    dismissals: Dismissal[];
    accounts: { id: string; display_name: string; plugin_id: string }[];
    resources: Record<string, string | null>[];
  }
  const state: State = {
    userData: "",
    dbError: null,
    dismissals: [],
    accounts: [
      { id: "acc-prod", display_name: "Production", plugin_id: "fake" },
      { id: "acc-stage", display_name: "Staging", plugin_id: "fake" },
      { id: "acc-other", display_name: "Elsewhere", plugin_id: "other" },
    ],
    resources: [],
  };
  const db = {
    async select(sql: string, params: unknown[] = []) {
      if (state.dbError) throw state.dbError;
      if (sql.includes("FROM resources")) return state.resources;
      if (sql.includes("FROM accounts")) {
        return sql.includes("IN (")
          ? state.accounts.filter((a) => params.includes(a.id))
          : state.accounts;
      }
      if (sql.startsWith("SELECT id FROM posture_dismissals")) {
        return state.dismissals
          .filter((d) => d.resource_id === params[0] && d.rule_id === params[1])
          .map((d) => ({ id: `${d.resource_id}:${d.rule_id}` }));
      }
      if (sql.includes("FROM posture_dismissals")) return state.dismissals;
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute(sql: string, params: unknown[] = []) {
      if (state.dbError) throw state.dbError;
      const [resourceId, ruleId] = sql.startsWith("INSERT") ? params.slice(1, 3) : params;
      state.dismissals = state.dismissals.filter(
        (d) => !(d.resource_id === resourceId && d.rule_id === ruleId),
      );
      if (sql.startsWith("INSERT")) {
        state.dismissals.push({
          resource_id: String(params[1]),
          rule_id: String(params[2]),
          reason: params[3] === null ? null : String(params[3]),
          updated_at: String(params[5]),
        });
      }
    },
  };
  const plugin = {
    manifest: { id: "fake", displayName: "Fake Cloud" },
    resourceTypes: [
      {
        id: "volume",
        displayName: "Volume",
        orphanRule: {
          conditions: [{ fieldKey: "attachedTo", when: "empty" }],
          reason: "Volume is not attached to anything",
        },
      },
      {
        id: "certificate",
        displayName: "Certificate",
        expiryFields: [
          { fieldKey: "notAfter", from: "expiry", kind: "tls-cert", label: "Certificate expires" },
        ],
      },
      {
        id: "bucket",
        displayName: "Bucket",
        postureChecks: [
          {
            id: "public-bucket",
            title: "Bucket allows public access",
            severity: "high",
            category: "public-exposure",
            conditions: [{ fieldKey: "public", when: "truthy" }],
            reason: "Anyone can read it",
          },
        ],
      },
    ],
    remediationCommands: () => [
      {
        tool: "fake-cli",
        command: "fake volume delete vol-1",
        description: "Delete the volume",
        destructive: true,
        placeholders: [{ name: "FAKE_PROFILE", description: "The profile to use" }],
      },
    ],
  };
  const listLive = vi.fn();
  return { state, db, plugin, listLive };
});

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ipcMain: new EventEmitter(),
    app: { getPath: () => h.state.userData, isPackaged: false, getAppPath: () => "" },
  };
});
vi.mock("../main-utils", () => ({ getDb: async () => h.db }));
vi.mock("../../src/plugins/loader", () => ({
  loadPlugins: async () => [{ plugin: h.plugin }],
  getPlugin: async () => ({ plugin: h.plugin }),
}));
vi.mock("../plugin-runtime", () => ({ listAccountResourcesLive: h.listLive }));

const { callDesktopRpc, failureOf } = await import("./rpc-harness");
const { DesktopRpcClient } = await import("../../src/lib/rpc/desktop-client");
const { LocalWorkspaceError } = await import("../../shared/rpc/errors");
const { LocalEnvironmentDiffError } =
  await import("../../shared/rpc/groups/local-environment-diff");

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

function resource(id: string, resourceTypeId: string, fields: Record<string, unknown>) {
  return {
    id,
    plugin_id: "fake",
    resource_type_id: resourceTypeId,
    account_id: "acc-prod",
    display_name: id,
    external_id: `ext-${id}`,
    parent_resource_id: null,
    fields_json: JSON.stringify(fields),
    last_synced_at: null,
  };
}

beforeEach(() => {
  h.state.dbError = null;
  h.state.dismissals = [];
  h.state.resources = [
    resource("vol-1", "volume", { attachedTo: "" }),
    resource("cert-1", "certificate", { notAfter: inDays(3) }),
    resource("bucket-1", "bucket", { public: true }),
  ];
  h.listLive.mockReset();
});

describe("LocalOrphansList", () => {
  it("answers the local orphan scan, remediation included", async () => {
    const response = await callDesktopRpc(DesktopRpcClient.use((rpc) => rpc.LocalOrphansList()));
    expect(response.costBasis).toBe("unavailable");
    expect(response.totalCount).toBe(1);
    const [flagged] = response.accounts[0]?.resources ?? [];
    expect(flagged).toMatchObject({
      id: "vol-1",
      reason: "Volume is not attached to anything",
      cost: null,
      owner: null,
    });
    expect(flagged?.remediation?.commands[0]).toMatchObject({
      tool: "fake-cli",
      destructive: true,
    });
  });

  it("fails with the database's reason when the workspace cannot be read", async () => {
    h.state.dbError = new Error("database is locked");
    const error = await failureOf(DesktopRpcClient.use((rpc) => rpc.LocalOrphansList()));
    expect(error).toBeInstanceOf(LocalWorkspaceError);
    expect(error).toMatchObject({ message: "database is locked" });
  });
});

describe("LocalExtendedSupportList", () => {
  it("answers at list price, with no billing block", async () => {
    const response = await callDesktopRpc(
      DesktopRpcClient.use((rpc) => rpc.LocalExtendedSupportList()),
    );
    expect(response).toMatchObject({ findings: [], totalCount: 0, currentMonthly: [] });
    expect(response).not.toHaveProperty("billing");
  });

  it("fails with the database's reason when the workspace cannot be read", async () => {
    h.state.dbError = new Error("database is locked");
    const error = await failureOf(DesktopRpcClient.use((rpc) => rpc.LocalExtendedSupportList()));
    expect(error).toBeInstanceOf(LocalWorkspaceError);
    expect(error).toMatchObject({ message: "database is locked" });
  });
});

describe("LocalDnsInventory", () => {
  it("answers the inventory over the workspace", async () => {
    const response = await callDesktopRpc(DesktopRpcClient.use((rpc) => rpc.LocalDnsInventory()));
    expect(response).toMatchObject({ zones: [], records: [], skippedNamespaces: [] });
    expect(response.counts.records).toBe(0);
  });

  it("fails with the database's reason when the workspace cannot be read", async () => {
    h.state.dbError = new Error("database is locked");
    const error = await failureOf(DesktopRpcClient.use((rpc) => rpc.LocalDnsInventory()));
    expect(error).toBeInstanceOf(LocalWorkspaceError);
  });
});

describe("LocalExpiringList", () => {
  it("answers the expiry feed, soonest first", async () => {
    const response = await callDesktopRpc(DesktopRpcClient.use((rpc) => rpc.LocalExpiringList()));
    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      resourceId: "cert-1",
      kind: "tls-cert",
      severity: "critical",
      accountName: "Production",
    });
    expect(response.counts.critical).toBe(1);
  });

  it("fails with the database's reason when the workspace cannot be read", async () => {
    h.state.dbError = new Error("database is locked");
    const error = await failureOf(DesktopRpcClient.use((rpc) => rpc.LocalExpiringList()));
    expect(error).toBeInstanceOf(LocalWorkspaceError);
  });
});

describe("LocalPosture", () => {
  const key = { resourceId: "bucket-1", ruleId: "public-bucket" };

  it("lists findings, and a dismissal moves one aside until it is restored", async () => {
    const before = await callDesktopRpc(DesktopRpcClient.use((rpc) => rpc.LocalPostureList()));
    expect(before.findings).toEqual([
      expect.objectContaining({ ...key, severity: "high", category: "public-exposure" }),
    ]);

    const stored = await callDesktopRpc(
      DesktopRpcClient.use((rpc) => rpc.LocalPostureDismiss({ ...key, reason: "  intended  " })),
    );
    expect(stored).toBe("intended");

    const dismissed = await callDesktopRpc(DesktopRpcClient.use((rpc) => rpc.LocalPostureList()));
    expect(dismissed.findings).toEqual([]);
    expect(dismissed.dismissed[0]?.dismissal).toMatchObject({
      reason: "intended",
      dismissedBy: null,
    });

    const restored = await callDesktopRpc(
      DesktopRpcClient.use((rpc) => rpc.LocalPostureRestore(key)),
    );
    expect(restored).toBe(true);
    const again = await callDesktopRpc(DesktopRpcClient.use((rpc) => rpc.LocalPostureRestore(key)));
    expect(again).toBe(false);
  });

  it("stores a blank note as no note", async () => {
    const stored = await callDesktopRpc(
      DesktopRpcClient.use((rpc) => rpc.LocalPostureDismiss({ ...key, reason: "   " })),
    );
    expect(stored).toBeNull();
  });

  it("fails a dismissal with the database's reason", async () => {
    h.state.dbError = new Error("attempt to write a readonly database");
    const error = await failureOf(
      DesktopRpcClient.use((rpc) => rpc.LocalPostureDismiss({ ...key, reason: "" })),
    );
    expect(error).toBeInstanceOf(LocalWorkspaceError);
    expect(error).toMatchObject({ message: "attempt to write a readonly database" });
  });
});

describe("LocalEnvironmentDiff", () => {
  const listed = (accountId: string, size: number) => ({
    resources: [
      {
        id: `${accountId}-web`,
        resourceTypeId: "bucket",
        displayName: "web",
        externalId: null,
        fields: { size },
        resolvedOutputs: {},
      },
    ],
    errors: accountId === "acc-stage" ? [{ typeId: "volume", message: "access denied" }] : [],
  });

  it("lists every declared type on both accounts and compares them", async () => {
    h.listLive.mockImplementation(async (account: { id: string }) =>
      listed(account.id, account.id === "acc-prod" ? 1 : 2),
    );
    const response = await callDesktopRpc(
      DesktopRpcClient.use((rpc) =>
        rpc.LocalEnvironmentDiff({
          accountIdA: "acc-prod",
          accountIdB: "acc-stage",
          includeIdentityFields: false,
        }),
      ),
    );
    expect(h.listLive).toHaveBeenCalledWith(
      { id: "acc-prod", displayName: "Production", pluginId: "fake" },
      { allTypes: true },
    );
    expect(response).toMatchObject({
      pluginName: "Fake Cloud",
      a: { accountName: "Production" },
      b: { accountName: "Staging" },
      unavailableTypes: [
        { resourceTypeId: "volume", resourceTypeName: "Volume", message: "access denied" },
      ],
    });
    expect(response.entries[0]?.changes).toEqual([{ field: "size", a: 1, b: 2 }]);
  });

  it("refuses accounts of different providers before calling either", async () => {
    const error = await failureOf(
      DesktopRpcClient.use((rpc) =>
        rpc.LocalEnvironmentDiff({
          accountIdA: "acc-prod",
          accountIdB: "acc-other",
          includeIdentityFields: false,
        }),
      ),
    );
    expect(error).toBeInstanceOf(LocalEnvironmentDiffError);
    expect(error.message).toContain("use different providers");
    expect(h.listLive).not.toHaveBeenCalled();
  });

  it("names an account that is not in the workspace", async () => {
    const error = await failureOf(
      DesktopRpcClient.use((rpc) =>
        rpc.LocalEnvironmentDiff({
          accountIdA: "acc-prod",
          accountIdB: "acc-gone",
          includeIdentityFields: false,
        }),
      ),
    );
    expect(error).toMatchObject({ message: "No account acc-gone in this workspace." });
  });
});

describe("LocalDeployHistory", () => {
  let tmpRoot = "";
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iw-rpc-deploys-"));
    h.state.userData = tmpRoot;
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  const run = (id: string) => ({
    id,
    startedAt: "2026-07-29T10:00:00.000Z",
    env: "production",
    repo: null,
    branch: "main",
    gitSha: null,
    dirty: true,
    image: null,
    status: "success",
    stage: "deploy",
    durationMs: 1200,
    dir: "/home/dev/app",
    notes: [],
    createdResources: [],
    error: null,
    orgId: null,
    output: { url: "https://app.example.com" },
  });

  it("is empty before anything has been deployed", async () => {
    const runs = await callDesktopRpc(DesktopRpcClient.use((rpc) => rpc.LocalDeployHistory()));
    expect(runs).toEqual([]);
  });

  it("answers runs newest first, skipping lines it cannot decode", async () => {
    const lines = [
      JSON.stringify(run("older")),
      JSON.stringify({ id: "wrong-shape", status: "exploded" }),
      '{"id":"trunc"',
      JSON.stringify(run("newer")),
    ];
    fs.writeFileSync(path.join(tmpRoot, "deploy-history.jsonl"), `${lines.join("\n")}\n`, "utf8");
    const runs = await callDesktopRpc(DesktopRpcClient.use((rpc) => rpc.LocalDeployHistory()));
    expect(runs.map((r) => r.id)).toEqual(["newer", "older"]);
    expect(runs[0]?.output).toEqual({ url: "https://app.example.com" });
  });
});
