import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@infrawrench/plugin-base";

const invoke = vi.fn();
const select = vi.fn();
const execute = vi.fn();

vi.mock("../invoke", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../../db/client", () => ({
  getDb: () => Promise.resolve({ select, execute }),
}));

import {
  sqlQuery,
  sqlExecute,
  buildHostServices,
  kvCommand,
  buildKvHostServices,
  buildMemcachedHostServices,
  dockerCommand,
  buildDockerHostServices,
  secretHostServices,
  persistOutputRef,
  buildPluginHostServices,
} from "../sql-drivers";

beforeEach(() => {
  invoke.mockReset();
  select.mockReset();
  execute.mockReset();
  invoke.mockResolvedValue(undefined);
  execute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 0 });
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-0000-0000-000000000000");
});

const manifest = (extra: Partial<PluginManifest> = {}): PluginManifest =>
  ({ id: "p", name: "P", resourceTypes: [], ...extra }) as unknown as PluginManifest;

describe("sqlQuery / sqlExecute", () => {
  it("sqlQuery routes to plugin_sql_query without caCert when absent", async () => {
    invoke.mockResolvedValue([{ a: 1 }]);
    const res = await sqlQuery("pg", "postgres://x", "SELECT 1");
    expect(invoke).toHaveBeenCalledWith("plugin_sql_query", {
      driverId: "pg",
      connectionString: "postgres://x",
      sql: "SELECT 1",
    });
    expect(res).toEqual([{ a: 1 }]);
  });

  it("sqlQuery includes caCert when provided", async () => {
    await sqlQuery("pg", "conn", "SELECT 1", { caCert: "CERT" });
    expect(invoke).toHaveBeenCalledWith("plugin_sql_query", {
      driverId: "pg",
      connectionString: "conn",
      sql: "SELECT 1",
      caCert: "CERT",
    });
  });

  it("sqlExecute routes to plugin_sql_execute with params and caCert", async () => {
    invoke.mockResolvedValue(3);
    const n = await sqlExecute("my", "conn", "DELETE", ["x"], { caCert: "C" });
    expect(invoke).toHaveBeenCalledWith("plugin_sql_execute", {
      driverId: "my",
      connectionString: "conn",
      sql: "DELETE",
      params: ["x"],
      caCert: "C",
    });
    expect(n).toBe(3);
  });

  it("sqlExecute omits caCert when not provided", async () => {
    await sqlExecute("my", "conn", "DELETE", []);
    expect(invoke).toHaveBeenCalledWith("plugin_sql_execute", {
      driverId: "my",
      connectionString: "conn",
      sql: "DELETE",
      params: [],
    });
  });
});

describe("buildHostServices", () => {
  it("wires sql.query and sql.execute through to invoke with caCert", async () => {
    const hs = buildHostServices("pg", "conn", { caCert: "C" });
    await hs.sql!.query("SELECT 1");
    await hs.sql!.execute("UPDATE", [1]);
    expect(invoke).toHaveBeenCalledWith("plugin_sql_query", {
      driverId: "pg",
      connectionString: "conn",
      sql: "SELECT 1",
      caCert: "C",
    });
    expect(invoke).toHaveBeenCalledWith("plugin_sql_execute", {
      driverId: "pg",
      connectionString: "conn",
      sql: "UPDATE",
      params: [1],
      caCert: "C",
    });
  });

  it("works without caCert (default options)", async () => {
    const hs = buildHostServices("pg", "conn");
    await hs.sql!.query("SELECT 1");
    expect(invoke).toHaveBeenCalledWith("plugin_sql_query", {
      driverId: "pg",
      connectionString: "conn",
      sql: "SELECT 1",
    });
  });
});

describe("kv host services", () => {
  it("kvCommand forwards command + args", async () => {
    invoke.mockResolvedValue("PONG");
    const res = await kvCommand("redis", "conn", "PING", "a", 1);
    expect(invoke).toHaveBeenCalledWith("plugin_kv_command", {
      driverId: "redis",
      connectionString: "conn",
      command: "PING",
      args: ["a", 1],
    });
    expect(res).toBe("PONG");
  });

  it("buildKvHostServices wires kv.command", async () => {
    const hs = buildKvHostServices("redis", "conn");
    await hs.kv!.command("GET", "key");
    expect(invoke).toHaveBeenCalledWith("plugin_kv_command", {
      driverId: "redis",
      connectionString: "conn",
      command: "GET",
      args: ["key"],
    });
  });

  it("buildMemcachedHostServices is the kv builder", () => {
    expect(buildMemcachedHostServices).toBe(buildKvHostServices);
  });
});

describe("docker host services", () => {
  it("dockerCommand forwards op + params", async () => {
    invoke.mockResolvedValue({ ok: true });
    const res = await dockerCommand("docker", "unix:///x", "list", { all: true });
    expect(invoke).toHaveBeenCalledWith("plugin_docker_command", {
      driverId: "docker",
      dockerHost: "unix:///x",
      op: "list",
      params: { all: true },
    });
    expect(res).toEqual({ ok: true });
  });

  it("buildDockerHostServices wires docker.command", async () => {
    const hs = buildDockerHostServices("docker", "host");
    await hs.docker!.command("ps", { q: 1 });
    expect(invoke).toHaveBeenCalledWith("plugin_docker_command", {
      driverId: "docker",
      dockerHost: "host",
      op: "ps",
      params: { q: 1 },
    });
  });
});

describe("secretHostServices.getPlaintext", () => {
  it("returns decrypted plaintext for a literal row", async () => {
    select.mockResolvedValue([
      { resolution_kind: "literal", encrypted_value: "ct", value_iv: "iv" },
    ]);
    invoke.mockResolvedValue("secret");
    const res = await secretHostServices.getPlaintext("res", "field");
    expect(res).toBe("secret");
    expect(invoke).toHaveBeenCalledWith("secret_field_decrypt", {
      resourceId: "res",
      fieldKey: "field",
      ciphertext: "ct",
      iv: "iv",
    });
  });

  it("returns null when no row exists", async () => {
    select.mockResolvedValue([]);
    expect(await secretHostServices.getPlaintext("res", "field")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns null when resolution_kind is not literal", async () => {
    select.mockResolvedValue([
      { resolution_kind: "output-ref", encrypted_value: "ct", value_iv: "iv" },
    ]);
    expect(await secretHostServices.getPlaintext("res", "field")).toBeNull();
  });

  it("returns null when encrypted_value/iv missing", async () => {
    select.mockResolvedValue([
      { resolution_kind: "literal", encrypted_value: null, value_iv: null },
    ]);
    expect(await secretHostServices.getPlaintext("res", "field")).toBeNull();
  });

  it("returns null and logs when the lookup throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    select.mockRejectedValue(new Error("db down"));
    expect(await secretHostServices.getPlaintext("res", "field")).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("secretHostServices.setPlaintext / persistPlaintextSecret", () => {
  it("encrypts then upserts the secret_field_states row", async () => {
    invoke.mockResolvedValue({ ciphertext: "CT", iv: "IV" });
    await secretHostServices.setPlaintext!("res", "field", "plain");
    expect(invoke).toHaveBeenCalledWith("secret_field_encrypt", {
      resourceId: "res",
      fieldKey: "field",
      plaintext: "plain",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, args] = execute.mock.calls[0]!;
    expect(String(sql)).toContain("INSERT INTO secret_field_states");
    expect(args).toEqual(["00000000-0000-0000-0000-000000000000", "res", "field", "CT", "IV"]);
  });
});

describe("persistOutputRef", () => {
  it("writes the output-ref row and a best-effort association row", async () => {
    invoke.mockResolvedValue({ ciphertext: "CT", iv: "IV" });
    await persistOutputRef("res", "field", {
      pluginId: "pl",
      resourceTypeId: "rt",
      resourceId: "src-res",
      accountId: "acc",
      outputKey: "out",
      value: "v",
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(String(execute.mock.calls[0]![0])).toContain("'output-ref'");
    expect(execute.mock.calls[0]![1]).toEqual([
      "00000000-0000-0000-0000-000000000000",
      "res",
      "field",
      "pl",
      "rt",
      "src-res",
      "acc",
      "out",
      "CT",
      "IV",
    ]);
    expect(String(execute.mock.calls[1]![0])).toContain("INSERT INTO associations");
  });

  it("swallows the association insert failure", async () => {
    invoke.mockResolvedValue({ ciphertext: "CT", iv: "IV" });
    execute
      .mockResolvedValueOnce({ rowsAffected: 1, lastInsertId: 0 }) // secret_field_states
      .mockRejectedValueOnce(new Error("no provider fk")); // associations
    await expect(
      persistOutputRef("res", "field", {
        pluginId: "pl",
        resourceTypeId: "rt",
        resourceId: "src-res",
        accountId: "acc",
        outputKey: "out",
        value: "v",
      }),
    ).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe("buildPluginHostServices", () => {
  it("returns base (http + secrets) for an HTTP-only plugin", () => {
    const hs = buildPluginHostServices(manifest(), {})!;
    expect(hs.http).toBeDefined();
    expect(hs.secrets).toBe(secretHostServices);
    expect(hs.sql).toBeUndefined();
    expect(hs.kv).toBeUndefined();
  });

  it("base http.request routes through the k8s_api_request channel", async () => {
    invoke.mockResolvedValue({ status: 200, headers: {}, body: "ok" });
    const hs = buildPluginHostServices(manifest(), {})!;
    const res = await hs.http!.request({
      url: "https://api/x",
      method: "GET",
      headers: { accept: "application/json" },
    });
    expect(invoke).toHaveBeenCalledWith("k8s_api_request", {
      url: "https://api/x",
      method: "GET",
      headers: { accept: "application/json" },
    });
    expect(res).toEqual({ status: 200, headers: {}, body: "ok" });
  });

  it("builds docker services from the dockerDriver credential", async () => {
    const hs = buildPluginHostServices(
      manifest({
        dockerDriver: { driver: "docker", credentialKey: "host" },
      } as Partial<PluginManifest>),
      { host: "tcp://1" },
    )!;
    expect(hs.docker).toBeDefined();
    expect(hs.secrets).toBe(secretHostServices);
    await hs.docker!.command("ps");
    expect(invoke).toHaveBeenCalledWith(
      "plugin_docker_command",
      expect.objectContaining({ dockerHost: "tcp://1", op: "ps" }),
    );
  });

  it("defaults docker host to empty string when credential missing", async () => {
    const hs = buildPluginHostServices(
      manifest({
        dockerDriver: { driver: "docker", credentialKey: "host" },
      } as Partial<PluginManifest>),
      {},
    )!;
    await hs.docker!.command("ps");
    expect(invoke).toHaveBeenCalledWith(
      "plugin_docker_command",
      expect.objectContaining({ dockerHost: "" }),
    );
  });

  it("builds k8s services from the kubernetesDriver credential", async () => {
    const hs = buildPluginHostServices(
      manifest({
        kubernetesDriver: { driver: "k8s", credentialKey: "kubeconfig" },
      } as Partial<PluginManifest>),
      { kubeconfig: "KC" },
    )!;
    expect(hs.k8s).toBeDefined();
    await hs.k8s!.command("get", { kind: "pods" });
    expect(invoke).toHaveBeenCalledWith(
      "plugin_k8s_command",
      expect.objectContaining({ kubeconfig: "KC", op: "get" }),
    );
  });

  it("builds sql services with a caCert from the manifest caCertKey", async () => {
    const hs = buildPluginHostServices(
      manifest({
        sqlDriver: { driver: "pg", credentialKey: "url", caCertKey: "ca" },
      } as Partial<PluginManifest>),
      { url: "postgres://x", ca: "CERT" },
    )!;
    await hs.sql!.query("SELECT 1");
    expect(invoke).toHaveBeenCalledWith(
      "plugin_sql_query",
      expect.objectContaining({ connectionString: "postgres://x", caCert: "CERT" }),
    );
  });

  it("builds sql services without caCert when no caCertKey", async () => {
    const hs = buildPluginHostServices(
      manifest({ sqlDriver: { driver: "pg", credentialKey: "url" } } as Partial<PluginManifest>),
      { url: "postgres://x" },
    )!;
    await hs.sql!.query("SELECT 1");
    const call = invoke.mock.calls.find((c) => c[0] === "plugin_sql_query")!;
    expect(call[1]).not.toHaveProperty("caCert");
  });

  it("defaults k8s/sql/kv connection strings to empty when credential missing", async () => {
    const k8s = buildPluginHostServices(
      manifest({
        kubernetesDriver: { driver: "k8s", credentialKey: "kc" },
      } as Partial<PluginManifest>),
      {},
    )!;
    await k8s.k8s!.command("get");
    expect(invoke).toHaveBeenCalledWith(
      "plugin_k8s_command",
      expect.objectContaining({ kubeconfig: "" }),
    );

    const sql = buildPluginHostServices(
      manifest({
        sqlDriver: { driver: "pg", credentialKey: "url", caCertKey: "ca" },
      } as Partial<PluginManifest>),
      {},
    )!;
    await sql.sql!.query("SELECT 1");
    const sqlCall = invoke.mock.calls.find((c) => c[0] === "plugin_sql_query")!;
    expect(sqlCall[1]).toMatchObject({ connectionString: "" });
    // caCert resolves to "" -> omitted from the sql payload
    expect(sqlCall[1]).not.toHaveProperty("caCert");

    const kv = buildPluginHostServices(
      manifest({ kvDriver: { driver: "redis", credentialKey: "url" } } as Partial<PluginManifest>),
      {},
    )!;
    await kv.kv!.command("PING");
    expect(invoke).toHaveBeenCalledWith(
      "plugin_kv_command",
      expect.objectContaining({ connectionString: "" }),
    );
  });

  it("builds kv services from the kvDriver credential", async () => {
    const hs = buildPluginHostServices(
      manifest({ kvDriver: { driver: "redis", credentialKey: "url" } } as Partial<PluginManifest>),
      { url: "redis://x" },
    )!;
    expect(hs.kv).toBeDefined();
    await hs.kv!.command("PING");
    expect(invoke).toHaveBeenCalledWith(
      "plugin_kv_command",
      expect.objectContaining({ connectionString: "redis://x", command: "PING" }),
    );
  });
});
