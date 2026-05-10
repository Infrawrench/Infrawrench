import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildTestApp } from "./test-utils";

const mockSelect = vi.fn();

vi.mock("@/db/client", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

vi.mock("@/services/encryption", () => ({
  decrypt: vi.fn().mockResolvedValue(
    JSON.stringify({
      connectionString: "postgres://localhost/db",
      redisUrl: "redis://localhost",
      dockerHost: "tcp://localhost:2375",
    }),
  ),
}));

const mockGetPlugin = vi.fn();
vi.mock("@/plugins/loader", () => ({
  getPlugin: (...args: unknown[]) => mockGetPlugin(...args),
}));

vi.mock("@/services/host-services", () => ({
  buildPluginHostServices: vi.fn().mockReturnValue({}),
}));

vi.mock("@/services/tunnel-resolver", () => ({
  rewriteConnectionForTunnel: vi.fn().mockImplementation((_accountId: string, cs: string) => cs),
  rewriteCredentialsThroughTunnel: vi.fn().mockResolvedValue(undefined),
}));

const mockSqlQuery = vi.fn();
const mockSqlExecute = vi.fn();
const mockKvCommand = vi.fn();
const mockDockerCommand = vi.fn();

vi.mock("@/services/drivers", () => ({
  sqlDrivers: new Map([
    [
      "postgres",
      {
        query: (...args: unknown[]) => mockSqlQuery(...args),
        execute: (...args: unknown[]) => mockSqlExecute(...args),
      },
    ],
  ]),
  kvDrivers: new Map([["redis", { command: (...args: unknown[]) => mockKvCommand(...args) }]]),
  dockerDrivers: new Map([
    ["docker-http", { command: (...args: unknown[]) => mockDockerCommand(...args) }],
  ]),
}));

vi.mock("@/services/sftp", () => ({
  sftpList: vi.fn(),
  sftpMkdir: vi.fn(),
  sftpDelete: vi.fn(),
}));

const { connectionFeatureRoutes } = await import("@/api/routes/connection-features");

const buildApp = () => buildTestApp(connectionFeatureRoutes);

function setupAccountSelect() {
  const account = {
    id: "a1",
    pluginId: "pg",
    encryptedCredentials: "enc",
    credentialsIv: "iv",
  };
  const limit = vi.fn().mockResolvedValue([account]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

describe("Connection feature routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /sql/query — SQL query proxying", () => {
    it("executes an account-level SQL query and returns rows with duration", async () => {
      setupAccountSelect();

      mockGetPlugin.mockResolvedValue({
        plugin: {
          manifest: {
            id: "pg",
            sqlDriver: { driver: "postgres", credentialKey: "connectionString" },
          },
          resourceTypes: [],
          createClient: vi.fn().mockReturnValue({}),
        },
      });

      const rows = [{ id: 1, name: "test" }];
      mockSqlQuery.mockResolvedValue(rows);

      const app = buildApp();
      const res = await app.request("/sql/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "a1", sql: "SELECT 1" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rows).toEqual(rows);
      expect(body).toHaveProperty("durationMs");
      expect(typeof body.durationMs).toBe("number");
    });

    it("returns 400 when no SQL driver is available", async () => {
      setupAccountSelect();

      mockGetPlugin.mockResolvedValue({
        plugin: {
          manifest: { id: "plain" },
          resourceTypes: [],
          createClient: vi.fn().mockReturnValue({}),
        },
      });

      const app = buildApp();
      const res = await app.request("/sql/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "a1", sql: "SELECT 1" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no sql driver/i);
    });

    it("uses REST-based executeQuery when resourceId is provided and client supports it", async () => {
      setupAccountSelect();

      const executeQuery = vi.fn().mockResolvedValue({ rows: [{ x: 1 }], columns: ["x"] });
      mockGetPlugin.mockResolvedValue({
        plugin: {
          manifest: { id: "bq" },
          resourceTypes: [],
          createClient: vi.fn().mockReturnValue({ executeQuery }),
        },
      });

      const app = buildApp();
      const res = await app.request("/sql/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "a1", resourceId: "r1", sql: "SELECT 1" }),
      });

      expect(res.status).toBe(200);
      expect(executeQuery).toHaveBeenCalledWith("r1", "a1", "SELECT 1");
    });
  });

  describe("POST /kv/command — KV command proxying", () => {
    it("executes a KV command and returns the result", async () => {
      setupAccountSelect();

      mockGetPlugin.mockResolvedValue({
        plugin: {
          manifest: {
            id: "redis-plugin",
            kvDriver: { driver: "redis", credentialKey: "redisUrl" },
          },
          resourceTypes: [],
          createClient: vi.fn().mockReturnValue({}),
        },
      });

      mockKvCommand.mockResolvedValue("PONG");

      const app = buildApp();
      const res = await app.request("/kv/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "a1", command: "PING", args: [] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toBe("PONG");
    });

    it("returns 400 when no KV driver is available", async () => {
      setupAccountSelect();

      mockGetPlugin.mockResolvedValue({
        plugin: {
          manifest: { id: "no-kv" },
          resourceTypes: [],
          createClient: vi.fn().mockReturnValue({}),
        },
      });

      const app = buildApp();
      const res = await app.request("/kv/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "a1", command: "PING", args: [] }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no kv driver/i);
    });
  });

  describe("POST /docker/command — Docker command proxying", () => {
    it("executes a Docker command and returns the result", async () => {
      setupAccountSelect();

      mockGetPlugin.mockResolvedValue({
        plugin: {
          manifest: {
            id: "docker-plugin",
            dockerDriver: { driver: "docker-http", credentialKey: "dockerHost" },
          },
          resourceTypes: [],
          createClient: vi.fn().mockReturnValue({}),
        },
      });

      const containers = [{ id: "c1", name: "web" }];
      mockDockerCommand.mockResolvedValue(containers);

      const app = buildApp();
      const res = await app.request("/docker/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "a1", op: "listContainers", params: {} }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toEqual(containers);
    });

    it("returns 400 when no Docker driver is available", async () => {
      setupAccountSelect();

      mockGetPlugin.mockResolvedValue({
        plugin: {
          manifest: { id: "no-docker" },
          resourceTypes: [],
          createClient: vi.fn().mockReturnValue({}),
        },
      });

      const app = buildApp();
      const res = await app.request("/docker/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "a1", op: "listContainers" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/no docker driver/i);
    });
  });
});
