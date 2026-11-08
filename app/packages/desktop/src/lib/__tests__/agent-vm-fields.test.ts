import initSqlJs, { type Database } from "sql.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../../db/client";
import { MIGRATIONS } from "../../db/schema";

/**
 * The agent VM paths read the VM back from its plugin and write the answer into its
 * resource row. A field that read could not fill keeps its stored value, as the sync
 * does, rather than vanish until the next refresh (#898). No provider is reached: the
 * plugin client is a stub.
 */

let sqlite: Database;
const db: DbClient = {
  async select<T>(sql: string, params: unknown[] = []): Promise<T> {
    const stmt = sqlite.prepare(sql);
    stmt.bind(params as never);
    const rows: unknown[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows as T;
  },
  async execute(sql: string, params: unknown[] = []) {
    sqlite.run(sql, params as never);
    return { rowsAffected: sqlite.getRowsModified(), lastInsertId: 0 };
  },
};

const getResource = vi.fn();
vi.mock("../../db/client", () => ({ getDb: async () => db }));
vi.mock("../plugin-client", () => ({ createPluginClient: async () => ({ getResource }) }));
vi.mock("../../plugins/loader", () => ({ loadPlugins: async () => [] }));
vi.mock("../local-secrets", () => ({
  ensureAgentSshKey: async () => ({
    id: "k1",
    name: "infrawrench-agent",
    publicKey: "ssh-ed25519 AAAA",
  }),
  getLocalSshPrivateKey: async () => "",
}));
vi.mock("@infrawrench/ui", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dispatchResourcesChanged: vi.fn(),
}));

const { createDesktopAgentClient } = await import("../agent-client");

const VM_ID = "a1:vm:42";
const answer = (fields: Record<string, unknown>) => ({
  id: VM_ID,
  pluginId: "fake",
  resourceTypeId: "vm",
  accountId: "a1",
  displayName: "agent-vm",
  fields,
  resolvedOutputs: {},
});

async function storedFields(): Promise<Record<string, unknown>> {
  const [row] = await db.select<Array<{ fields_json: string }>>(
    "SELECT fields_json FROM resources WHERE id = $1",
    [VM_ID],
  );
  return JSON.parse(row!.fields_json) as Record<string, unknown>;
}

beforeEach(async () => {
  getResource.mockReset();
  const SQL = await initSqlJs();
  sqlite = new SQL.Database();
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS) {
    for (const stmt of migration.split(";").flatMap((s) => (s.trim() ? [s.trim()] : []))) {
      try {
        sqlite.run(stmt);
      } catch (err) {
        if (!String(err).includes("duplicate column name")) throw err;
      }
    }
  }
  sqlite.run(
    "INSERT INTO accounts (id, plugin_id, display_name, encrypted_credentials, credentials_iv) VALUES ('a1','fake','A','x','y')",
  );
  sqlite.run(
    `INSERT INTO resources (id, plugin_id, resource_type_id, account_id, display_name, external_id, fields_json)
     VALUES ($1, 'fake', 'vm', 'a1', 'agent-vm', '42', $2)`,
    [VM_ID, JSON.stringify({ status: "starting", region: "fsn1", note: "x" })],
  );
});

function addSession(id: string) {
  // A failed session is left alone by the setup auto-resume, which would reach SSH.
  sqlite.run(
    `INSERT INTO agent_sessions (id, repo, project_name, account_id, plugin_id, resource_type_id, branch_name, status, vm_resource_id)
     VALUES ($1, '/work/repo', 'repo', 'a1', 'fake', 'vm', 'agent/x', 'failed', $2)`,
    [id, VM_ID],
  );
}

describe("the agent VM's resource row", () => {
  it("merges the status refresh's answer into the stored fields", async () => {
    addSession("s-refresh");
    getResource.mockResolvedValue(answer({ status: "running", note: "" }));
    await createDesktopAgentClient().listSessions();
    // A field the plugin clears on purpose is an explicit value, and still applies.
    expect(await storedFields()).toEqual({ status: "running", region: "fsn1", note: "" });
  });

  it("merges the VM load's answer into the stored fields", async () => {
    addSession("s-load");
    const client = createDesktopAgentClient();
    // The first refresh starts the verify backoff, so the reconcile's own read is the load.
    getResource.mockResolvedValue(answer({ status: "running", region: "fsn1", note: "x" }));
    await client.listSessions();
    getResource.mockResolvedValue(answer({ status: "stopped" }));
    // No resource type exposes SSH here, so the reconcile stops after loading the VM.
    await expect(client.reconcileSession("s-load")).rejects.toThrow(/SSH endpoint/);
    expect(getResource).toHaveBeenCalledTimes(2);
    expect(await storedFields()).toEqual({ status: "stopped", region: "fsn1", note: "x" });
  });
});
