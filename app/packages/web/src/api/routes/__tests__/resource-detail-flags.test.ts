import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthSession } from "@/api/auth-middleware";

/**
 * Tests that the web resource-detail API route derives feature flags
 * identically to how desktop does — ensuring SSH, SFTP, SQL, KV, Docker,
 * and storage features are visible in the web UI wherever desktop shows them.
 *
 * Root cause of the parity gap: web's resource-detail route only checked
 * client.getSshConfig() for SSH/SFTP, but desktop also checks
 * resourceTypeDef.sshEndpoint to enable SSH for cloud VMs like EC2 droplets,
 * Hetzner servers, etc.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockInsert = vi.fn();
const mockDelete = vi.fn();
const mockUpdate = vi.fn();

vi.mock("@/db/client", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

vi.mock("@/services/encryption", () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: "enc", iv: "iv" }),
  decrypt: vi.fn().mockResolvedValue(JSON.stringify({ host: "1.2.3.4", username: "root", privateKey: "key" })),
}));

const mockGetPlugin = vi.fn();
vi.mock("@/plugins/loader", () => ({
  getPlugin: (...args: unknown[]) => mockGetPlugin(...args),
}));

vi.mock("@/services/host-services", () => ({
  buildPluginHostServices: vi.fn().mockReturnValue({}),
}));

vi.mock("@/services/drivers", () => ({
  sqlDrivers: new Map(),
  kvDrivers: new Map(),
  dockerDrivers: new Map(),
}));

const { resourceDetailRoutes } = await import("@/api/routes/resource-detail");

// ── Helpers ────────────────────────────────────────────────────────────────

function buildApp() {
  const app = new Hono();
  const session: AuthSession = {
    userId: "user-1",
    organizationId: "org-1",
    email: "test@example.com",
  };
  app.use("*", async (c, next) => {
    c.set("session", session);
    return next();
  });
  app.route("/", resourceDetailRoutes);
  return app;
}

const DB_RESOURCE = {
  id: "res-1",
  organizationId: "org-1",
  pluginId: "aws",
  resourceTypeId: "ec2-instance",
  accountId: "acct-1",
  displayName: "My EC2",
  externalId: "i-123",
  fieldsJson: { publicIp: "1.2.3.4", state: "running" },
  outputsJson: { publicIp: "1.2.3.4" },
  parentResourceId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  lastSyncedAt: new Date(),
  deletedAt: null,
};

const ACCOUNT = {
  id: "acct-1",
  pluginId: "aws",
  encryptedCredentials: "enc",
  credentialsIv: "iv",
};

interface SetupOpts {
  sshEndpoint?: { hostOutputKey: string };
  getSshConfig?: (() => { host: string; port: number; username: string; privateKey: string }) | null;
  sqlDriver?: { driver: string; credentialKey: string } | null;
  kvDriver?: { driver: string; credentialKey: string } | null;
  dockerDriver?: { driver: string; credentialKey: string } | null;
  storageBrowser?: { bucketName: string } | null;
  resourceSqlDriver?: { driver: string; connectionStringOutputKey: string } | null;
  executeQuery?: boolean;
}

function setupMocks(opts: SetupOpts = {}, resourceOverride?: typeof DB_RESOURCE) {
  const dbResource = resourceOverride ?? DB_RESOURCE;

  // Build a fully chainable mock: .from().where().limit() all return same result
  function makeChain(result: unknown) {
    // Create a thenable object that resolves to result
    function makeThenable(extraMethods: Record<string, unknown> = {}) {
      return {
        then: (fn: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(fn, rej),
        catch: (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn),
        limit: vi.fn().mockResolvedValue(result),
        ...extraMethods,
      };
    }
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(makeThenable()),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(makeThenable()),
        }),
      }),
    };
  }

  // The route calls db.select() multiple times:
  // 1. Resource lookup: db.select().from(resources).where(...).limit(1)
  // 2. Secret field states: db.select().from(secretFieldStates).where(...)
  // 3. Account lookup in getClientForAccount: db.select({cols}).from(accounts).where(...).limit(1)
  // 4+. Child resources, etc.
  let callCount = 0;
  mockSelect.mockImplementation(() => {
    callCount++;
    if (callCount === 1) return makeChain([dbResource]);        // Resource lookup
    if (callCount === 2) return makeChain([ACCOUNT]);            // Account lookup (getClientForAccount)
    if (callCount === 3) return makeChain([]);                   // Secret field states
    return makeChain([]);                                        // Any further calls
  });

  const detailSchema: Record<string, unknown> = {
    title: "My EC2",
    sections: [],
  };
  if (opts.storageBrowser) detailSchema.storageBrowser = opts.storageBrowser;

  const liveInstance = {
    id: dbResource.id,
    pluginId: dbResource.pluginId,
    resourceTypeId: dbResource.resourceTypeId,
    accountId: dbResource.accountId,
    displayName: dbResource.displayName,
    fields: dbResource.fieldsJson,
    resolvedOutputs: dbResource.outputsJson ?? {},
    secretStates: [],
    createdAt: dbResource.createdAt.toISOString(),
    updatedAt: dbResource.updatedAt.toISOString(),
  };
  const mockClient: Record<string, unknown> = {
    listResources: vi.fn().mockResolvedValue([liveInstance]),
    getResource: vi.fn().mockResolvedValue(null),
    renderDetail: vi.fn().mockReturnValue(detailSchema),
    renderSidebarItem: vi.fn().mockReturnValue({ id: "res-1", label: "My EC2" }),
    resolveOutput: vi.fn().mockResolvedValue(""),
  };

  if (opts.getSshConfig !== null) {
    mockClient.getSshConfig = opts.getSshConfig ?? undefined;
  }
  if (opts.executeQuery) {
    mockClient.executeQuery = vi.fn().mockResolvedValue({ rows: [], durationMs: 0 });
  }

  const resourceTypes = [
    {
      id: "ec2-instance",
      displayName: "EC2 Instance",
      pluralDisplayName: "EC2 Instances",
      fields: [],
      ...(opts.sshEndpoint ? { sshEndpoint: opts.sshEndpoint } : {}),
      ...(opts.resourceSqlDriver ? { resourceSqlDriver: opts.resourceSqlDriver } : {}),
    },
  ];

  const manifest: Record<string, unknown> = {
    id: "aws",
    displayName: "AWS",
    logoSvg: "<svg/>",
    credentialFields: [],
  };
  if (opts.sqlDriver) manifest.sqlDriver = opts.sqlDriver;
  if (opts.kvDriver) manifest.kvDriver = opts.kvDriver;
  if (opts.dockerDriver) manifest.dockerDriver = opts.dockerDriver;

  // Mock db.insert().values().onConflictDoUpdate() for background DB update
  const onConflictDoUpdate = vi.fn().mockReturnValue({ catch: vi.fn() });
  const insertValues = vi.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing: vi.fn().mockResolvedValue(undefined) });
  mockInsert.mockReturnValue({ values: insertValues });

  // Mock db.update().set().where() for background soft-delete
  const updateWhere = vi.fn().mockReturnValue({ catch: vi.fn() });
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  mockUpdate.mockReturnValue({ set: updateSet });

  mockGetPlugin.mockResolvedValue({
    plugin: {
      manifest,
      resourceTypes,
      createClient: vi.fn().mockReturnValue(mockClient),
    },
  });

  return { mockClient };
}

async function getDetail(app: Hono) {
  const res = await app.request(
    "/aws/ec2-instance/detail?resourceId=res-1&accountId=acct-1",
    { method: "GET" },
  );
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`Expected 200 but got ${res.status}: ${body}`);
  }
  return res.json();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("resource-detail feature flag parity with desktop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── SSH via plugin's getSshConfig() ─────────────────────────────────────

  it("hasSshTerminal=true when client.getSshConfig() returns config (SSH plugin)", async () => {
    setupMocks({
      getSshConfig: () => ({ host: "1.2.3.4", port: 22, username: "root", privateKey: "key" }),
    });

    const body = await getDetail(buildApp());
    expect(body.hasSshTerminal).toBe(true);
    expect(body.hasSftpBrowser).toBe(true);
  });

  it("hasSshTerminal=false when no SSH support at all", async () => {
    setupMocks({ getSshConfig: null });

    const body = await getDetail(buildApp());
    expect(body.hasSshTerminal).toBe(false);
    expect(body.hasSftpBrowser).toBe(false);
  });

  // ── SSH via sshEndpoint (the parity fix) ────────────────────────────────

  it("hasSshTerminal=true when resourceType has sshEndpoint and resource has the host field", async () => {
    setupMocks({
      getSshConfig: null,
      sshEndpoint: { hostOutputKey: "publicIp" },
    });

    const body = await getDetail(buildApp());
    expect(body.hasSshTerminal).toBe(true);
    expect(body.hasSftpBrowser).toBe(true);
    expect(body.sshHost).toBe("1.2.3.4");
  });

  it("hasSshTerminal=false when sshEndpoint declared but host field is empty", async () => {
    const emptyResource = { ...DB_RESOURCE, fieldsJson: { state: "running" }, outputsJson: {} };
    setupMocks(
      { getSshConfig: null, sshEndpoint: { hostOutputKey: "publicIp" } },
      emptyResource,
    );

    const body = await getDetail(buildApp());
    expect(body.hasSshTerminal).toBe(false);
    expect(body.hasSftpBrowser).toBe(false);
    expect(body.sshHost).toBeNull();
  });

  // ── SQL Editor ──────────────────────────────────────────────────────────

  it("hasSqlEditor=true when manifest has sqlDriver", async () => {
    setupMocks({
      getSshConfig: null,
      sqlDriver: { driver: "postgres", credentialKey: "connectionString" },
    });

    const body = await getDetail(buildApp());
    expect(body.hasSqlEditor).toBe(true);
  });

  it("hasSqlEditor=true when resourceType has resourceSqlDriver", async () => {
    setupMocks({
      getSshConfig: null,
      resourceSqlDriver: { driver: "postgres", connectionStringOutputKey: "connString" },
    });

    const body = await getDetail(buildApp());
    expect(body.hasSqlEditor).toBe(true);
  });

  it("hasSqlEditor=true when client has executeQuery", async () => {
    setupMocks({
      getSshConfig: null,
      executeQuery: true,
    });

    const body = await getDetail(buildApp());
    expect(body.hasSqlEditor).toBe(true);
  });

  it("hasSqlEditor=false when no SQL support", async () => {
    setupMocks({ getSshConfig: null });

    const body = await getDetail(buildApp());
    expect(body.hasSqlEditor).toBe(false);
  });

  // ── KV Console ──────────────────────────────────────────────────────────

  it("hasKvConsole=true when manifest has kvDriver", async () => {
    setupMocks({
      getSshConfig: null,
      kvDriver: { driver: "redis", credentialKey: "connectionString" },
    });

    const body = await getDetail(buildApp());
    expect(body.hasKvConsole).toBe(true);
    expect(body.kvDriverName).toBe("redis");
    expect(body.isMongoDb).toBe(false);
  });

  it("isMongoDb=true when kvDriver is mongodb", async () => {
    setupMocks({
      getSshConfig: null,
      kvDriver: { driver: "mongodb", credentialKey: "connectionString" },
    });

    const body = await getDetail(buildApp());
    expect(body.hasKvConsole).toBe(true);
    expect(body.isMongoDb).toBe(true);
  });

  // ── Docker ──────────────────────────────────────────────────────────────

  it("hasDockerActions=true when manifest has dockerDriver", async () => {
    setupMocks({
      getSshConfig: null,
      dockerDriver: { driver: "docker", credentialKey: "dockerHost" },
    });

    const body = await getDetail(buildApp());
    expect(body.hasDockerActions).toBe(true);
  });

  // ── Storage Browser ─────────────────────────────────────────────────────

  it("hasStorageBrowser=true when detailSchema has storageBrowser", async () => {
    setupMocks({
      getSshConfig: null,
      storageBrowser: { bucketName: "my-bucket" },
    });

    const body = await getDetail(buildApp());
    expect(body.hasStorageBrowser).toBe(true);
    expect(body.storageBucketName).toBe("my-bucket");
  });

  it("hasStorageBrowser=false when no storage", async () => {
    setupMocks({ getSshConfig: null });

    const body = await getDetail(buildApp());
    expect(body.hasStorageBrowser).toBe(false);
  });

  // ── Combined flags (real-world scenarios) ──────────────────────────────

  it("SSH plugin: has SSH+SFTP via getSshConfig, no SQL/KV/Docker", async () => {
    setupMocks({
      getSshConfig: () => ({ host: "1.2.3.4", port: 22, username: "root", privateKey: "key" }),
    });

    const body = await getDetail(buildApp());
    expect(body.hasSshTerminal).toBe(true);
    expect(body.hasSftpBrowser).toBe(true);
    expect(body.hasSqlEditor).toBe(false);
    expect(body.hasKvConsole).toBe(false);
    expect(body.hasDockerActions).toBe(false);
    expect(body.hasStorageBrowser).toBe(false);
  });

  it("cloud VM with sshEndpoint: has SSH+SFTP, no SQL/KV/Docker", async () => {
    setupMocks({
      getSshConfig: null,
      sshEndpoint: { hostOutputKey: "publicIp" },
    });

    const body = await getDetail(buildApp());
    expect(body.hasSshTerminal).toBe(true);
    expect(body.hasSftpBrowser).toBe(true);
    expect(body.hasSqlEditor).toBe(false);
    expect(body.hasKvConsole).toBe(false);
    expect(body.hasDockerActions).toBe(false);
  });

  it("postgres plugin: has SQL, no SSH/KV/Docker", async () => {
    setupMocks({
      getSshConfig: null,
      sqlDriver: { driver: "postgres", credentialKey: "connectionString" },
    });

    const body = await getDetail(buildApp());
    expect(body.hasSqlEditor).toBe(true);
    expect(body.hasSshTerminal).toBe(false);
    expect(body.hasKvConsole).toBe(false);
    expect(body.hasDockerActions).toBe(false);
  });
});
