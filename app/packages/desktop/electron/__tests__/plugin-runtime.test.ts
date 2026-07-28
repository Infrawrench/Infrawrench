import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Plugin, PluginManifest, ResourceInstance } from "@infrawrench/plugin-base";

// vi.mock factories are hoisted above every const in this file, so the driver
// stubs have to be created inside them and read back afterwards.
vi.mock("../drivers", () => ({
  sqlDrivers: new Map([["pg", { id: "pg", query: vi.fn(), execute: vi.fn() }]]),
  kvDrivers: new Map([["redis", { id: "redis", command: vi.fn() }]]),
  dockerDrivers: new Map([["docker", { id: "docker", command: vi.fn() }]]),
  k8sDrivers: new Map([["k8s", { id: "k8s", command: vi.fn() }]]),
  storageDrivers: new Map(),
}));

const getPlugin = vi.fn();
vi.mock("../../src/plugins/loader", () => ({
  getPlugin: (...args: unknown[]) => getPlugin(...args),
}));

const prepare = vi.fn();
vi.mock("../db", () => ({
  getSqlite: () => Promise.resolve({ prepare, run: vi.fn() }),
  normalizeSql: (sql: string) => sql,
  persist: vi.fn(),
}));

const decryptValue = vi.fn();
vi.mock("../main-utils", () => ({
  buildAad: (a: string, b: string, c: string) => `${a}:${b}:${c}`,
  decryptValue: (...args: unknown[]) => decryptValue(...args),
  encryptValue: () => ({ ciphertext: "ct", iv: "iv" }),
  getEncryptionKey: () => Buffer.alloc(32),
  UserFacingError: class UserFacingError extends Error {},
}));

import {
  buildPluginHostServices,
  getAccountCredentials,
  listAccountResourcesLive,
  resolveResourceOutputs,
} from "../plugin-runtime";
import { sqlDrivers, kvDrivers, dockerDrivers, k8sDrivers } from "../drivers";

const sqlDriver = sqlDrivers.get("pg") as unknown as { query: Mock; execute: Mock };
const kvDriver = kvDrivers.get("redis") as unknown as { command: Mock };
const dockerDriver = dockerDrivers.get("docker") as unknown as { command: Mock };
const k8sDriver = k8sDrivers.get("k8s") as unknown as { command: Mock };

const manifest = (extra: Partial<PluginManifest> = {}): PluginManifest =>
  ({ id: "p", name: "P", resourceTypes: [], ...extra }) as unknown as PluginManifest;

/** A sql.js prepared statement that yields one row then stops. */
function stubRow(row: Record<string, unknown> | null): void {
  let stepped = false;
  prepare.mockReturnValue({
    bind: vi.fn(),
    step: () => {
      if (row === null || stepped) return false;
      stepped = true;
      return true;
    },
    getAsObject: () => row,
    free: vi.fn(),
  });
}

const account = { id: "acc-1", pluginId: "digitalocean", displayName: "DO" };

function resource(typeId: string, name: string): ResourceInstance {
  return {
    id: `acc-1:${typeId}:${name}`,
    pluginId: "digitalocean",
    resourceTypeId: typeId,
    accountId: "acc-1",
    displayName: name,
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    createdAt: "",
    updatedAt: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  decryptValue.mockReturnValue(JSON.stringify({ apiToken: "tok" }));
  stubRow({ encrypted_credentials: "v2:ct", credentials_iv: "iv" });
});

describe("buildPluginHostServices", () => {
  it("always supplies http and secrets", () => {
    const services = buildPluginHostServices(manifest(), {});
    expect(services.http).toBeDefined();
    expect(services.secrets).toBeDefined();
  });

  it("wires the sql driver straight through, no IPC", async () => {
    sqlDriver.query.mockResolvedValue([{ n: 1 }]);
    const services = buildPluginHostServices(
      manifest({ sqlDriver: { driver: "pg", credentialKey: "connectionString" } }),
      { connectionString: "postgres://x" },
    );
    await services.sql!.query("SELECT 1");
    expect(sqlDriver.query).toHaveBeenCalledWith("postgres://x", "SELECT 1", undefined);
  });

  it("passes a caCert through to the sql driver when the manifest names one", async () => {
    const services = buildPluginHostServices(
      manifest({ sqlDriver: { driver: "pg", credentialKey: "cs", caCertKey: "ca" } }),
      { cs: "postgres://x", ca: "PEM" },
    );
    await services.sql!.query("SELECT 1");
    expect(sqlDriver.query).toHaveBeenCalledWith("postgres://x", "SELECT 1", { caCert: "PEM" });
  });

  it("wires kv, docker and k8s drivers from their credential keys", async () => {
    const kv = buildPluginHostServices(
      manifest({ kvDriver: { driver: "redis", credentialKey: "u" } }),
      {
        u: "redis://h",
      },
    );
    await kv.kv!.command("GET", "k");
    expect(kvDriver.command).toHaveBeenCalledWith("redis://h", "GET", ["k"]);

    const docker = buildPluginHostServices(
      manifest({ dockerDriver: { driver: "docker", credentialKey: "host" } }),
      { host: "unix:///x.sock" },
    );
    await docker.docker!.command("ps", {});
    expect(dockerDriver.command).toHaveBeenCalledWith("unix:///x.sock", "ps", {});

    const k8s = buildPluginHostServices(
      manifest({ kubernetesDriver: { driver: "k8s", credentialKey: "kubeconfig" } }),
      { kubeconfig: "apiVersion: v1" },
    );
    await k8s.k8s!.command("listPods", {});
    expect(k8sDriver.command).toHaveBeenCalledWith("apiVersion: v1", "listPods", {});
  });

  it("throws on an unregistered driver rather than returning a broken bundle", () => {
    expect(() =>
      buildPluginHostServices(manifest({ sqlDriver: { driver: "nope", credentialKey: "cs" } }), {}),
    ).toThrow(/No SQL driver/);
  });
});

describe("getAccountCredentials", () => {
  it("decrypts with the same AAD the GUI's account_get_credentials uses", async () => {
    const creds = await getAccountCredentials("acc-1");
    expect(creds).toEqual({ apiToken: "tok" });
    expect(decryptValue).toHaveBeenCalledWith(
      "v2:ct",
      "iv",
      expect.anything(),
      "account:acc-1:credentials",
    );
  });

  it("reports a missing account instead of decrypting empty strings", async () => {
    stubRow(null);
    await expect(getAccountCredentials("nope")).rejects.toThrow(/not found/);
  });
});

describe("listAccountResourcesLive", () => {
  const plugin = (resourceTypes: unknown[], listResources: unknown): { plugin: Plugin } =>
    ({
      plugin: {
        manifest: manifest(),
        resourceTypes,
        createClient: () => ({ listResources, resolveOutput: vi.fn() }),
      },
    }) as unknown as { plugin: Plugin };

  it("lists top-level types and child types that opted into the sidebar", async () => {
    const listResources = vi.fn().mockResolvedValue([]);
    getPlugin.mockResolvedValue(
      plugin(
        [
          { id: "droplet" },
          { id: "snapshot", parentTypeId: "droplet", showInSidebar: true },
          { id: "disk", parentTypeId: "droplet" },
        ],
        listResources,
      ),
    );
    await listAccountResourcesLive(account);
    expect(listResources.mock.calls.map((c) => c[0])).toEqual(["droplet", "snapshot"]);
  });

  it("keeps the types that worked and reports the ones that failed", async () => {
    const listResources = vi.fn(async (typeId: string) => {
      if (typeId === "volume") throw new Error("403 Forbidden");
      return [resource(typeId, "b"), resource(typeId, "a")];
    });
    getPlugin.mockResolvedValue(plugin([{ id: "droplet" }, { id: "volume" }], listResources));

    const { resources, errors } = await listAccountResourcesLive(account);
    expect(resources.map((r) => r.displayName)).toEqual(["a", "b"]);
    expect(errors).toEqual([{ typeId: "volume", message: "403 Forbidden" }]);
  });

  it("lists only the requested type when one is given", async () => {
    const listResources = vi.fn().mockResolvedValue([]);
    getPlugin.mockResolvedValue(plugin([{ id: "droplet" }, { id: "volume" }], listResources));
    await listAccountResourcesLive(account, { typeId: "volume" });
    expect(listResources.mock.calls.map((c) => c[0])).toEqual(["volume"]);
  });

  it("rejects an unknown type and names the ones that do exist", async () => {
    getPlugin.mockResolvedValue(plugin([{ id: "droplet" }, { id: "volume" }], vi.fn()));
    await expect(listAccountResourcesLive(account, { typeId: "nope" })).rejects.toThrow(
      /no resource type "nope"\. Known types: droplet, volume\./,
    );
  });

  it("names the plugin when it isn't available", async () => {
    getPlugin.mockResolvedValue(undefined);
    await expect(listAccountResourcesLive(account)).rejects.toThrow(/digitalocean/);
  });
});

describe("resolveResourceOutputs", () => {
  it("resolves visible outputs and skips sensitive and hidden ones", async () => {
    const resolveOutput = vi.fn(async (_t: string, _r: string, key: string) => `${key}-value`);
    getPlugin.mockResolvedValue({
      plugin: {
        manifest: manifest(),
        resourceTypes: [
          {
            id: "droplet",
            outputs: [
              { key: "ipv4", sensitive: false },
              { key: "rootPassword", sensitive: true },
              { key: "kubeconfig", sensitive: false, hidden: true },
            ],
          },
        ],
        createClient: () => ({ listResources: vi.fn(), resolveOutput }),
      },
    } as unknown as { plugin: Plugin });

    const outputs = await resolveResourceOutputs(account, "droplet", "acc-1:droplet:1");
    expect(outputs).toEqual({ ipv4: "ipv4-value" });
  });

  it("drops the outputs that fail rather than failing the whole pane", async () => {
    const resolveOutput = vi.fn(async (_t: string, _r: string, key: string) => {
      if (key === "ipv6") throw new Error("not enabled");
      return "1.2.3.4";
    });
    getPlugin.mockResolvedValue({
      plugin: {
        manifest: manifest(),
        resourceTypes: [
          {
            id: "droplet",
            outputs: [
              { key: "ipv4", sensitive: false },
              { key: "ipv6", sensitive: false },
            ],
          },
        ],
        createClient: () => ({ listResources: vi.fn(), resolveOutput }),
      },
    } as unknown as { plugin: Plugin });

    await expect(resolveResourceOutputs(account, "droplet", "id")).resolves.toEqual({
      ipv4: "1.2.3.4",
    });
  });
});
