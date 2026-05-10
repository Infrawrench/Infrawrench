import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

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

const insertCalls: Array<{ values: unknown; conflictSet: unknown }> = [];
const updateCalls: Array<{ set: unknown }> = [];

const mockUpdate = vi.fn();
const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockSelectDistinct = vi.fn();
const mockDelete = vi.fn();

const dbMock = {
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    select: (...args: unknown[]) => mockSelect(...args),
    selectDistinct: (...args: unknown[]) => mockSelectDistinct(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
};
vi.mock("@/db/client", () => dbMock);
vi.mock("@infrawrench/server-core/db/client", () => dbMock);

const encryptionMock = {
  encrypt: vi.fn().mockResolvedValue({ ciphertext: "enc", iv: "iv" }),
  decrypt: vi.fn().mockResolvedValue(JSON.stringify({ token: "secret" })),
};
vi.mock("@/services/encryption", () => encryptionMock);
vi.mock("@infrawrench/server-core/encryption", () => encryptionMock);

const mockGetPlugin = vi.fn();
const pluginLoaderMock = {
  loadPlugins: vi.fn().mockResolvedValue([]),
  getPlugin: (...args: unknown[]) => mockGetPlugin(...args),
};
vi.mock("@/plugins/loader", () => pluginLoaderMock);
vi.mock("@infrawrench/server-core/plugin-loader", () => pluginLoaderMock);

const hostServicesMock = {
  buildPluginHostServices: vi.fn().mockReturnValue({}),
  buildHostServices: vi.fn().mockReturnValue({}),
  buildKvHostServices: vi.fn().mockReturnValue({}),
  buildDockerHostServices: vi.fn().mockReturnValue({}),
};
vi.mock("@/services/host-services", () => hostServicesMock);
vi.mock("@infrawrench/server-core/host-services", () => hostServicesMock);

vi.mock("@infrawrench/server-core/tunnel-resolver", () => ({
  rewriteCredentialsThroughTunnel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("uuid", () => ({ v4: () => "uuid-1" }));

const { accountRoutes } = await import("@/api/routes/accounts");

const buildApp = () => buildTestApp(accountRoutes);

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

  // db.selectDistinct().from().innerJoin().where() → refreshPinnedStats pinned lookup (empty)
  const distinctWhere = vi.fn().mockResolvedValue([]);
  const distinctInnerJoin = vi.fn().mockReturnValue({ where: distinctWhere });
  const distinctFrom = vi.fn().mockReturnValue({ innerJoin: distinctInnerJoin });
  mockSelectDistinct.mockReturnValue({ from: distinctFrom });

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
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0]!.set).toMatchObject({
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

    // One soft-delete call for synced resources not in live list
    expect(updateCalls.length).toBe(1);
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
    // conflictSet uses a SQL fragment to merge fields json (preserves
    // user-supplied keys not returned by the plugin), so just verify
    // displayName is overwritten on conflict.
    expect(insertCalls[0]!.conflictSet).toMatchObject({
      displayName: "Updated Name",
    });
  });

  it("handles multiple resources correctly — keeps live, deletes stale", async () => {
    // Two VMs alive, previously there were three
    setupSync([makeResource("vm-1", "VM One"), makeResource("vm-3", "VM Three")]);

    const app = buildApp();
    const res = await app.request("/acct-1/sync", { method: "POST" });
    const body = await res.json();
    expect(body.synced).toBe(2);

    // Two inserts for the live resources
    expect(insertCalls.length).toBe(2);
    expect(insertCalls.map((c) => (c.values as { id: string }).id).sort()).toEqual([
      "vm-1",
      "vm-3",
    ]);

    // One soft-delete call for synced resources not in live list
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0]!.set).toMatchObject({
      deletedAt: expect.any(Date),
    });
  });
});
