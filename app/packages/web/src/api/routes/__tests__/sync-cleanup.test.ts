import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthSession } from "@/api/auth-middleware";

/**
 * Tests that the web resource sync correctly removes stale resources,
 * matching desktop behavior where resources are fetched live from the
 * plugin and only current resources are displayed.
 *
 * Root cause of the bug: syncAccountResources() previously only upserted
 * resources — it never removed resources that the plugin no longer returned.
 * Desktop doesn't have this issue because it queries the plugin directly
 * and never persists resource state in a DB.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

const insertCalls: Array<{ values: unknown; conflictSet: unknown }> = [];
const updateCalls: Array<{ set: unknown }> = [];

const mockUpdate = vi.fn();
const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockDelete = vi.fn();

vi.mock("@/db/client", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock("@/services/encryption", () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: "enc", iv: "iv" }),
  decrypt: vi.fn().mockResolvedValue(JSON.stringify({ token: "secret" })),
}));

const mockGetPlugin = vi.fn();
vi.mock("@/plugins/loader", () => ({
  loadPlugins: vi.fn().mockResolvedValue([]),
  getPlugin: (...args: unknown[]) => mockGetPlugin(...args),
}));

vi.mock("@/services/host-services", () => ({
  buildPluginHostServices: vi.fn().mockReturnValue({}),
}));

vi.mock("uuid", () => ({ v4: () => "uuid-1" }));

const { accountRoutes } = await import("@/api/routes/accounts");

// ── Helpers ────────────────────────────────────────────────────────────────

function buildApp() {
  const app = new Hono();
  const session: AuthSession = {
    userId: "user-1",
    email: "test@example.com",
  };
  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("organizationId", "org-1");
    return next();
  });
  app.route("/", accountRoutes);
  return app;
}

const ACCOUNT = {
  id: "acct-1",
  organizationId: "org-1",
  pluginId: "aws",
  encryptedCredentials: "enc",
  credentialsIv: "iv",
};

function makeResource(id: string, displayName: string) {
  return {
    id,
    pluginId: "aws",
    resourceTypeId: "ec2-instance",
    accountId: "acct-1",
    displayName,
    fields: { state: "running" },
    resolvedOutputs: {},
  };
}

function setupSync(pluginResources: ReturnType<typeof makeResource>[]) {
  // db.select().from().where() → account lookup
  const selectWhere = vi.fn().mockResolvedValue([ACCOUNT]);
  const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
  mockSelect.mockReturnValue({ from: selectFrom });

  // Plugin returns these resources
  const mockClient = {
    listResources: vi.fn().mockResolvedValue(pluginResources),
  };
  mockGetPlugin.mockResolvedValue({
    plugin: {
      manifest: { id: "aws" },
      resourceTypes: [{ id: "ec2-instance" }],
      createClient: vi.fn().mockReturnValue(mockClient),
    },
  });

  // db.insert().values().onConflictDoUpdate()
  insertCalls.length = 0;
  const onConflictDoUpdate = vi.fn().mockImplementation((conflict) => {
    insertCalls[insertCalls.length - 1]!.conflictSet = conflict.set;
    return Promise.resolve();
  });
  const values = vi.fn().mockImplementation((v) => {
    insertCalls.push({ values: v, conflictSet: null });
    return { onConflictDoUpdate };
  });
  mockInsert.mockReturnValue({ values });

  // db.update().set().where()
  updateCalls.length = 0;
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockImplementation((s) => {
    updateCalls.push({ set: s });
    return { where: updateWhere };
  });
  mockUpdate.mockReturnValue({ set: updateSet });

  return { mockClient, updateWhere, updateSet };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("syncAccountResources stale resource cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("soft-deletes resources not returned by plugin (the core bug fix)", async () => {
    // Plugin returns only vm-2; vm-1 was previously in DB but is now deleted upstream
    setupSync([makeResource("vm-2", "Running VM")]);

    const app = buildApp();
    const res = await app.request("/acct-1/sync", { method: "POST" });
    expect(res.status).toBe(200);

    // Verify the upsert happened for vm-2
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0]!.values).toMatchObject({ id: "vm-2", displayName: "Running VM" });

    // Verify db.update was called to soft-delete stale resources
    // Call 1: soft-delete synced resources not in live list
    // Call 2: clean up stale locally-created resources (lastSyncedAt IS NULL, older than 5 min)
    expect(updateCalls.length).toBe(2);
    expect(updateCalls[0]!.set).toMatchObject({
      deletedAt: expect.any(Date),
    });
    expect(updateCalls[1]!.set).toMatchObject({
      deletedAt: expect.any(Date),
    });
  });

  it("soft-deletes ALL resources when plugin returns empty list", async () => {
    // All VMs deleted upstream
    setupSync([]);

    const app = buildApp();
    const res = await app.request("/acct-1/sync", { method: "POST" });
    expect(res.status).toBe(200);

    // No inserts since no resources returned
    expect(insertCalls.length).toBe(0);

    // Call 1: soft-delete synced resources
    // Call 2: clean up stale locally-created resources
    expect(updateCalls.length).toBe(2);
    expect(updateCalls[0]!.set).toMatchObject({
      deletedAt: expect.any(Date),
    });
  });

  it("clears deletedAt when a previously-deleted resource reappears", async () => {
    // VM that was soft-deleted comes back (e.g., transient API error earlier)
    setupSync([makeResource("vm-revived", "Revived VM")]);

    const app = buildApp();
    await app.request("/acct-1/sync", { method: "POST" });

    // The upsert should set deletedAt: null to undelete it
    expect(insertCalls.length).toBe(1);
    expect(insertCalls[0]!.values).toMatchObject({
      id: "vm-revived",
      deletedAt: null,
    });
    // The onConflictDoUpdate should also set deletedAt: null
    expect(insertCalls[0]!.conflictSet).toMatchObject({
      deletedAt: null,
    });
  });

  it("updates display name and fields during upsert", async () => {
    setupSync([makeResource("vm-1", "Updated Name")]);

    const app = buildApp();
    await app.request("/acct-1/sync", { method: "POST" });

    expect(insertCalls[0]!.values).toMatchObject({
      displayName: "Updated Name",
      fieldsJson: { state: "running" },
    });
    expect(insertCalls[0]!.conflictSet).toMatchObject({
      displayName: "Updated Name",
      fieldsJson: { state: "running" },
    });
  });

  it("handles multiple resources correctly — keeps live, deletes stale", async () => {
    // Two VMs alive, previously there were three
    setupSync([
      makeResource("vm-1", "VM One"),
      makeResource("vm-3", "VM Three"),
    ]);

    const app = buildApp();
    const res = await app.request("/acct-1/sync", { method: "POST" });
    const body = await res.json();
    expect(body.synced).toBe(2);

    // Two inserts for the live resources
    expect(insertCalls.length).toBe(2);
    expect(insertCalls.map((c) => (c.values as { id: string }).id).sort()).toEqual(["vm-1", "vm-3"]);

    // Two update calls: one for synced resources not in live list,
    // one for stale locally-created resources
    expect(updateCalls.length).toBe(2);
    expect(updateCalls[0]!.set).toMatchObject({
      deletedAt: expect.any(Date),
    });
  });
});
