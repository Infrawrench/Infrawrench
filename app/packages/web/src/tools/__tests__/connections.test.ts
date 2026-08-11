import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetClientForAccount = vi.fn();
const mockGetClientForResource = vi.fn();
vi.mock("../../services/plugin-clients", () => ({
  getClientForAccount: (...a: unknown[]) => mockGetClientForAccount(...a),
  getClientForResource: (...a: unknown[]) => mockGetClientForResource(...a),
}));

const mockRewrite = vi.fn(async (_acct: string, cs: string) => cs);
vi.mock("../../services/tunnel-resolver", () => ({
  rewriteConnectionForTunnel: (a: unknown, b: unknown) => mockRewrite(a as string, b as string),
}));

const mockSqlQuery = vi.fn();
const mockSqlExecute = vi.fn();
const mockKvCommand = vi.fn();
const mockDockerCommand = vi.fn();
const sqlDriver = { query: mockSqlQuery, execute: mockSqlExecute };
const kvDriver = { command: mockKvCommand };
const dockerDriver = { command: mockDockerCommand };
vi.mock("../../services/drivers", () => ({
  sqlDrivers: new Map([["postgres", sqlDriver]]),
  kvDrivers: new Map([["redis", kvDriver]]),
  dockerDrivers: new Map([["docker", dockerDriver]]),
}));

const mockResolveSshConfig = vi.fn();
const mockSshExec = vi.fn();
vi.mock("../../services/ssh", () => ({
  resolveSshConfig: (...a: unknown[]) => mockResolveSshConfig(...a),
  sshExec: (...a: unknown[]) => mockSshExec(...a),
}));

const mockResolveSafeHost = vi.fn();
vi.mock("../../services/host-validation", () => ({
  resolveSafeHost: (...a: unknown[]) => mockResolveSafeHost(...a),
}));

vi.mock("../../services/audit", () => ({ logAudit: vi.fn() }));
// Not importOriginal: the real module pulls in db/client, which requires
// DATABASE_URL at import time. Only the class identity matters here.
vi.mock("../../services/ssh-host-keys", () => ({
  HostKeyTrustRequiredError: class HostKeyTrustRequiredError extends Error {},
}));

const { connectionTools } = await import("../connections");
const tools = connectionTools();
const tool = (name: string) => tools.find((t) => t.name === name)!;
const auth = { userId: "u1", organizationId: "o1", source: "chat" as const };

describe("connectionTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRewrite.mockImplementation(async (_a: string, cs: string) => cs);
  });

  describe("sql_query", () => {
    it("errors when account not found", async () => {
      mockGetClientForAccount.mockResolvedValue(null);
      const r = await tool("sql_query").handler({ accountId: "a1", sql: "SELECT 1" }, auth);
      expect(r.isError).toBe(true);
    });

    it("uses account-level SQL driver and truncates at 500 rows", async () => {
      mockGetClientForAccount.mockResolvedValue({
        client: {},
        plugin: {
          manifest: { sqlDriver: { driver: "postgres", credentialKey: "url" } },
          resourceTypes: [],
        },
        credentials: { url: "postgres://x" },
      });
      mockSqlQuery.mockResolvedValue(new Array(600).fill({ a: 1 }));
      const r = await tool("sql_query").handler({ accountId: "a1", sql: "SELECT 1" }, auth);
      const out = JSON.parse(r.content[0]!.text);
      expect(out.rows).toHaveLength(500);
      expect(out.truncated).toBe(true);
    });

    it("uses executeQuery REST path when resourceId + client.executeQuery", async () => {
      const executeQuery = vi.fn().mockResolvedValue({ rows: [] });
      mockGetClientForAccount.mockResolvedValue({
        client: { executeQuery },
        plugin: { manifest: {}, resourceTypes: [] },
        credentials: {},
      });
      const r = await tool("sql_query").handler(
        { accountId: "a1", sql: "SELECT 1", resourceId: "r1" },
        auth,
      );
      expect(executeQuery).toHaveBeenCalledWith("r1", "a1", "SELECT 1");
      expect(r.isError).toBeUndefined();
    });

    it("errors when no SQL driver available", async () => {
      mockGetClientForAccount.mockResolvedValue({
        client: {},
        plugin: { manifest: {}, resourceTypes: [] },
        credentials: {},
      });
      const r = await tool("sql_query").handler({ accountId: "a1", sql: "x" }, auth);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/No SQL driver/);
      expect(r.content[0]!.text).toMatch(/sidecar/);
    });

    it("routes through the sidecar client when pluginId is given", async () => {
      mockGetClientForResource.mockResolvedValue({
        client: {},
        plugin: {
          manifest: { sqlDriver: { driver: "postgres", credentialKey: "connectionString" } },
          resourceTypes: [],
        },
        credentials: { connectionString: "postgres://neon" },
      });
      mockSqlQuery.mockResolvedValue([{ a: 1 }]);
      const r = await tool("sql_query").handler(
        { accountId: "a1", sql: "SELECT 1", pluginId: "postgres", parentResourceId: "db1" },
        auth,
      );
      expect(mockGetClientForResource).toHaveBeenCalledWith("postgres", "a1", "o1", "db1");
      expect(mockSqlQuery).toHaveBeenCalledWith("postgres://neon", "SELECT 1");
      expect(JSON.parse(r.content[0]!.text).rows).toEqual([{ a: 1 }]);
    });
  });

  describe("introspect_sql_schema", () => {
    it("errors with a sidecar hint when the account plugin lacks introspect", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      const r = await tool("introspect_sql_schema").handler({ accountId: "a1" }, auth);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/pluginId/);
      expect(r.content[0]!.text).toMatch(/parentResourceId/);
    });

    it("prefers introspectResource when resourceId is given (REST databases)", async () => {
      const introspectResource = vi.fn().mockResolvedValue([{ name: "events", columns: [] }]);
      const introspect = vi.fn();
      mockGetClientForAccount.mockResolvedValue({ client: { introspectResource, introspect } });
      const r = await tool("introspect_sql_schema").handler(
        { accountId: "a1", resourceId: "svc1" },
        auth,
      );
      expect(introspectResource).toHaveBeenCalledWith("svc1", "a1");
      expect(introspect).not.toHaveBeenCalled();
      expect(JSON.parse(r.content[0]!.text)).toEqual([{ name: "events", columns: [] }]);
    });

    it("introspects via the sidecar client when pluginId is given", async () => {
      const introspect = vi.fn().mockResolvedValue([{ name: "users", columns: [] }]);
      mockGetClientForResource.mockResolvedValue({ client: { introspect } });
      const r = await tool("introspect_sql_schema").handler(
        { accountId: "a1", pluginId: "postgres", parentResourceId: "db1" },
        auth,
      );
      expect(mockGetClientForResource).toHaveBeenCalledWith("postgres", "a1", "o1", "db1");
      expect(JSON.parse(r.content[0]!.text)).toEqual([{ name: "users", columns: [] }]);
    });
  });

  describe("sql_execute", () => {
    it("returns affectedRows via account driver", async () => {
      mockGetClientForAccount.mockResolvedValue({
        client: {},
        plugin: {
          manifest: { sqlDriver: { driver: "postgres", credentialKey: "url" } },
          resourceTypes: [],
        },
        credentials: { url: "postgres://x" },
      });
      mockSqlExecute.mockResolvedValue(3);
      const r = await tool("sql_execute").handler({ accountId: "a1", sql: "DELETE FROM t" }, auth);
      expect(JSON.parse(r.content[0]!.text).affectedRows).toBe(3);
    });
  });

  describe("kv_command", () => {
    it("errors when no KV driver on account", async () => {
      mockGetClientForAccount.mockResolvedValue({
        client: {},
        plugin: { manifest: {} },
        credentials: {},
      });
      const r = await tool("kv_command").handler(
        { accountId: "a1", command: "GET", args: ["k"] },
        auth,
      );
      expect(r.isError).toBe(true);
    });

    it("runs the KV command", async () => {
      mockGetClientForAccount.mockResolvedValue({
        client: {},
        plugin: { manifest: { kvDriver: { driver: "redis", credentialKey: "url" } } },
        credentials: { url: "redis://x" },
      });
      mockKvCommand.mockResolvedValue("OK");
      const r = await tool("kv_command").handler(
        { accountId: "a1", command: "SET", args: ["k", "v"] },
        auth,
      );
      expect(JSON.parse(r.content[0]!.text).result).toBe("OK");
    });
  });

  describe("docker_command", () => {
    it("runs a docker op", async () => {
      mockGetClientForAccount.mockResolvedValue({
        client: {},
        plugin: { manifest: { dockerDriver: { driver: "docker", credentialKey: "host" } } },
        credentials: { host: "tcp://x" },
      });
      mockDockerCommand.mockResolvedValue([{ id: "c1" }]);
      const r = await tool("docker_command").handler(
        { accountId: "a1", op: "containers.list" },
        auth,
      );
      expect(JSON.parse(r.content[0]!.text).result).toEqual([{ id: "c1" }]);
    });
  });

  describe("ssh_exec", () => {
    it("returns stdout on success", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      mockResolveSshConfig.mockResolvedValue({ host: "h", username: "u" });
      mockSshExec.mockResolvedValue("hello\n");
      const r = await tool("ssh_exec").handler({ accountId: "a1", command: "echo hi" }, auth);
      const out = JSON.parse(r.content[0]!.text);
      expect(out.stdout).toBe("hello\n");
      expect(out.code).toBe(0);
    });

    it("errors when ssh config resolution fails", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      mockResolveSshConfig.mockRejectedValue(new Error("no key"));
      const r = await tool("ssh_exec").handler({ accountId: "a1", command: "x" }, auth);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toBe("no key");
    });

    it("returns error result when sshExec throws", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      mockResolveSshConfig.mockResolvedValue({ host: "h" });
      mockSshExec.mockRejectedValue(new Error("conn refused"));
      const r = await tool("ssh_exec").handler({ accountId: "a1", command: "x" }, auth);
      expect(r.isError).toBe(true);
    });

    // MCP exposes every tool regardless of `risk`, so a caller-named host here
    // is unguarded outbound SSH for anyone holding `resources:execute` — and
    // unlike the rebinding case it needs no DNS control, just the address.
    it("refuses a caller-supplied host in blocked address space", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      mockResolveSshConfig.mockResolvedValue({ host: "169.254.169.254", port: 22 });
      mockResolveSafeHost.mockRejectedValue(
        new Error("SSH host 169.254.169.254 resolves to a blocked address range"),
      );
      const r = await tool("ssh_exec").handler(
        { accountId: "a1", command: "x", sshKeyId: "k1", sshHost: "169.254.169.254" },
        auth,
      );
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/blocked address range/);
      expect(mockSshExec).not.toHaveBeenCalled();
    });

    it("dials the vetted address for a caller-supplied host, keeping the name", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      mockResolveSshConfig.mockResolvedValue({ host: "box.example", port: 22 });
      mockResolveSafeHost.mockResolvedValue("198.51.100.3");
      mockSshExec.mockResolvedValue("ok\n");
      const r = await tool("ssh_exec").handler(
        { accountId: "a1", command: "x", sshKeyId: "k1", sshHost: "box.example" },
        auth,
      );
      expect(r.isError).toBeFalsy();
      expect(mockResolveSafeHost).toHaveBeenCalledWith("box.example");
      expect(mockSshExec).toHaveBeenCalledWith(
        "o1",
        expect.objectContaining({ host: "box.example" }),
        "x",
        { dialAddress: "198.51.100.3" },
      );
    });

    // The plugin's own endpoint (Fly, Hetzner, an SSH account's credentials)
    // is configuration written with `accounts:write`, not something the caller
    // named — `resolveSshConfig` ignores `sshHost` entirely in that case.
    it("leaves a plugin-supplied endpoint unpinned", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      mockResolveSshConfig.mockResolvedValue({ host: "fly-machine.internal", port: 22 });
      mockSshExec.mockResolvedValue("ok\n");
      await tool("ssh_exec").handler(
        { accountId: "a1", command: "x", sshHost: "ignored.example" },
        auth,
      );
      expect(mockResolveSafeHost).not.toHaveBeenCalled();
      expect(mockSshExec).toHaveBeenCalledWith("o1", expect.anything(), "x", undefined);
    });
  });

  describe("storage tools", () => {
    it("list_storage_objects errors if unsupported", async () => {
      mockGetClientForAccount.mockResolvedValue({ client: {} });
      const r = await tool("list_storage_objects").handler(
        { accountId: "a1", bucket: "b", prefix: "" },
        auth,
      );
      expect(r.isError).toBe(true);
    });

    it("delete_storage_object calls plugin and audits", async () => {
      const deleteStorageObject = vi.fn().mockResolvedValue(undefined);
      mockGetClientForAccount.mockResolvedValue({ client: { deleteStorageObject } });
      const r = await tool("delete_storage_object").handler(
        { accountId: "a1", bucket: "b", key: "k" },
        auth,
      );
      expect(deleteStorageObject).toHaveBeenCalledWith("b", "k");
      expect(JSON.parse(r.content[0]!.text).ok).toBe(true);
    });
  });

  describe("secret-version tools", () => {
    it("list_secret_versions errors if unsupported", async () => {
      mockGetClientForResource.mockResolvedValue({ client: {} });
      const r = await tool("list_secret_versions").handler(
        { pluginId: "gcp", accountId: "a1", resourceTypeId: "rt", resourceId: "r1" },
        auth,
      );
      expect(r.isError).toBe(true);
    });

    it("access_secret_version returns the value and audits", async () => {
      const accessSecretVersion = vi.fn().mockResolvedValue("s3cr3t");
      mockGetClientForResource.mockResolvedValue({ client: { accessSecretVersion } });
      const r = await tool("access_secret_version").handler(
        {
          pluginId: "gcp",
          accountId: "a1",
          resourceTypeId: "rt",
          resourceId: "r1",
          versionId: "v1",
        },
        auth,
      );
      expect(JSON.parse(r.content[0]!.text).value).toBe("s3cr3t");
    });

    it("modify_secret_version disables a version", async () => {
      const modifySecretVersion = vi.fn().mockResolvedValue({ id: "v1", state: "disabled" });
      mockGetClientForResource.mockResolvedValue({ client: { modifySecretVersion } });
      const r = await tool("modify_secret_version").handler(
        {
          pluginId: "gcp",
          accountId: "a1",
          resourceTypeId: "rt",
          resourceId: "r1",
          versionId: "v1",
          action: "disable",
        },
        auth,
      );
      expect(modifySecretVersion).toHaveBeenCalledWith("rt", "r1", "a1", "v1", "disable");
      expect(JSON.parse(r.content[0]!.text).state).toBe("disabled");
    });
  });

  describe("export_credential", () => {
    it("errors when unsupported", async () => {
      mockGetClientForResource.mockResolvedValue({ client: {} });
      const r = await tool("export_credential").handler(
        { pluginId: "aws", accountId: "a1", resourceTypeId: "rt", resourceId: "r1", formatId: "f" },
        auth,
      );
      expect(r.isError).toBe(true);
    });
  });
});
