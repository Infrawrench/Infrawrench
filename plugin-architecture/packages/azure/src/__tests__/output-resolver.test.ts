import { describe, it, expect, vi } from "vitest";
import { resolveAzureOutput } from "../output-resolver.js";
import type { ResourceInstance } from "@infrawrench/plugin-base";

function res(partial: Partial<ResourceInstance>): ResourceInstance {
  return {
    id: "acct:t:ext",
    pluginId: "azure",
    resourceTypeId: "azure-vm",
    accountId: "acct",
    displayName: "x",
    fields: {},
    resolvedOutputs: {},
    secretStates: [],
    externalId: "rg/name",
    createdAt: "now",
    updatedAt: "now",
    ...partial,
  };
}

function makeDeps(opts: {
  post?: (url: string, body: unknown) => unknown;
  resource?: ResourceInstance;
  exportSecret?: () => Promise<string>;
}) {
  return {
    ctx: {
      get: vi.fn(),
      post: vi.fn(async (url: string, body: unknown) => opts.post?.(url, body) ?? {}),
      put: vi.fn(),
      patch: vi.fn(),
      del: vi.fn(),
      subscriptionId: "sub1",
      tenantId: "t1",
    },
    getResource: vi.fn(async () => opts.resource ?? res({})),
    exportAppRegistrationSecret: opts.exportSecret ?? vi.fn(async () => "secret!"),
  };
}

describe("resolveAzureOutput", () => {
  it("AKS kubeconfig decodes the base64 value", async () => {
    const encoded = btoa("kubeconfig-content");
    const deps = makeDeps({
      resource: res({ resourceTypeId: "azure-aks-cluster", externalId: "rg1/k1" }),
      post: (url) => {
        expect(url).toContain("listClusterUserCredential");
        return { kubeconfigs: [{ value: encoded }] };
      },
    });
    const out = await resolveAzureOutput(deps, "azure-aks-cluster", "id", "kubeconfig", "acct");
    expect(out).toBe("kubeconfig-content");
  });

  it("Cosmos primaryKey returns the master key", async () => {
    const deps = makeDeps({
      resource: res({ resourceTypeId: "azure-cosmos-db", externalId: "rg1/c1" }),
      post: () => ({ primaryMasterKey: "cosmos-key" }),
    });
    const out = await resolveAzureOutput(deps, "azure-cosmos-db", "id", "primaryKey", "acct");
    expect(out).toBe("cosmos-key");
  });

  it("Cosmos connectionString returns the first connection string", async () => {
    const deps = makeDeps({
      resource: res({ resourceTypeId: "azure-cosmos-db", externalId: "rg1/c1" }),
      post: () => ({ connectionStrings: [{ connectionString: "cs://cosmos" }] }),
    });
    const out = await resolveAzureOutput(deps, "azure-cosmos-db", "id", "connectionString", "acct");
    expect(out).toBe("cs://cosmos");
  });

  it("Storage primaryKey and connectionString", async () => {
    const deps = makeDeps({
      resource: res({ resourceTypeId: "azure-storage-account", externalId: "rg1/s1" }),
      post: () => ({ keys: [{ keyName: "key1", value: "abc" }] }),
    });
    expect(
      await resolveAzureOutput(deps, "azure-storage-account", "id", "primaryKey", "acct"),
    ).toBe("abc");
    const cs = await resolveAzureOutput(
      deps,
      "azure-storage-account",
      "id",
      "connectionString",
      "acct",
    );
    expect(cs).toContain("AccountName=s1");
    expect(cs).toContain("AccountKey=abc");
  });

  it("Redis primaryKey and connectionString", async () => {
    const deps = makeDeps({
      resource: res({
        resourceTypeId: "azure-redis-cache",
        externalId: "rg1/r1",
        fields: { name: "r1" },
      }),
      post: () => ({ primaryKey: "rk" }),
    });
    expect(await resolveAzureOutput(deps, "azure-redis-cache", "id", "primaryKey", "acct")).toBe(
      "rk",
    );
    const cs = await resolveAzureOutput(
      deps,
      "azure-redis-cache",
      "id",
      "connectionString",
      "acct",
    );
    expect(cs).toContain("r1.redis.cache.windows.net:6380");
    expect(cs).toContain("password=rk");
  });

  it("Service Bus and Event Hub primary connection strings", async () => {
    const deps = makeDeps({
      resource: res({ resourceTypeId: "azure-service-bus", externalId: "rg1/sb1" }),
      post: () => ({ primaryConnectionString: "Endpoint=sb://..." }),
    });
    expect(
      await resolveAzureOutput(deps, "azure-service-bus", "id", "primaryConnectionString", "acct"),
    ).toBe("Endpoint=sb://...");
    expect(
      await resolveAzureOutput(deps, "azure-event-hub", "id", "primaryConnectionString", "acct"),
    ).toBe("Endpoint=sb://...");
  });

  it("SQL Database connection string is built from fields", async () => {
    const deps = makeDeps({
      resource: res({
        resourceTypeId: "azure-sql-database",
        fields: { serverName: "srv1", name: "db1" },
      }),
    });
    const cs = await resolveAzureOutput(
      deps,
      "azure-sql-database",
      "id",
      "connectionString",
      "acct",
    );
    expect(cs).toContain("Server=tcp:srv1.database.windows.net,1433");
    expect(cs).toContain("Initial Catalog=db1");
  });

  it("Log Analytics primarySharedKey", async () => {
    const deps = makeDeps({
      resource: res({ resourceTypeId: "azure-log-analytics", externalId: "rg1/la1" }),
      post: () => ({ primarySharedKey: "shared" }),
    });
    expect(
      await resolveAzureOutput(deps, "azure-log-analytics", "id", "primarySharedKey", "acct"),
    ).toBe("shared");
  });

  it("Postgres and MySQL connection strings use resolvedOutputs", async () => {
    const pg = makeDeps({
      resource: res({
        resourceTypeId: "azure-postgres-flexible",
        resolvedOutputs: { fqdn: "pg.host", administratorLogin: "pgadmin" },
      }),
    });
    expect(
      await resolveAzureOutput(pg, "azure-postgres-flexible", "id", "connectionString", "acct"),
    ).toContain("postgresql://pgadmin:{your_password}@pg.host:5432");

    const my = makeDeps({
      resource: res({
        resourceTypeId: "azure-mysql-flexible",
        resolvedOutputs: { fqdn: "my.host", administratorLogin: "myadmin" },
      }),
    });
    expect(
      await resolveAzureOutput(my, "azure-mysql-flexible", "id", "connectionString", "acct"),
    ).toContain("mysql://myadmin:{your_password}@my.host:3306");
  });

  it("App registration clientSecret delegates to exportAppRegistrationSecret", async () => {
    const exportSecret = vi.fn(async () => "the-secret");
    const deps = makeDeps({ exportSecret });
    const out = await resolveAzureOutput(
      deps,
      "azure-app-registration",
      "id",
      "clientSecret",
      "acct",
    );
    expect(out).toBe("the-secret");
    expect(exportSecret).toHaveBeenCalled();
  });

  it("falls back to resolvedOutputs for unmatched keys", async () => {
    const deps = makeDeps({
      resource: res({ resolvedOutputs: { publicIp: "9.9.9.9" } }),
    });
    expect(await resolveAzureOutput(deps, "azure-vm", "id", "publicIp", "acct")).toBe("9.9.9.9");
  });

  it("throws when the output key cannot be resolved", async () => {
    const deps = makeDeps({ resource: res({ resolvedOutputs: {} }) });
    await expect(resolveAzureOutput(deps, "azure-vm", "id", "nope", "acct")).rejects.toThrow(
      /cannot resolve output "nope"/,
    );
  });
});
