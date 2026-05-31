import { describe, it, expect, vi } from "vitest";
import { getAzureCreateConfig } from "../create-config-dispatch.js";
import type { AzureCreateContext } from "../create-handlers-shared.js";

function makeCtx(): AzureCreateContext {
  return {
    // Items carry both `name` and a full ARM `id` — some handlers (function-app,
    // sql-database) extract the resource group from `id` via a regex .match().
    get: vi.fn(async () => ({
      value: [
        {
          id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Storage/storageAccounts/rg1",
          name: "rg1",
        },
      ],
    })),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => undefined),
    makeId: (a, t, e) => `${a}:${t}:${e}`,
    graphClient: {} as never,
    subscriptionId: "sub1",
    tenantId: "t1",
    clientId: "c1",
    clientSecret: "s1",
  };
}

const TYPES = [
  "azure-app-registration",
  "azure-vm",
  "azure-aks-cluster",
  "azure-storage-account",
  "azure-cosmos-db",
  "azure-redis-cache",
  "azure-postgres-flexible",
  "azure-mysql-flexible",
  "azure-log-analytics",
  "azure-managed-identity",
  "azure-dns-zone",
  "azure-vnet",
  "azure-nsg",
  "azure-key-vault",
  "azure-container-registry",
  "azure-resource-group",
  "azure-container-instance",
  "azure-service-bus",
  "azure-event-hub",
  "azure-public-ip",
  "azure-disk",
  "azure-app-service",
  "azure-function-app",
  "azure-sql-database",
  "azure-load-balancer",
];

describe("getAzureCreateConfig", () => {
  for (const type of TYPES) {
    it(`returns a fields config for ${type}`, async () => {
      const config = await getAzureCreateConfig(makeCtx(), type);
      expect(Array.isArray(config.fields)).toBe(true);
      expect(config.fields.length).toBeGreaterThan(0);
      // Every field has a key + kind
      for (const f of config.fields) {
        expect(f.key).toBeTruthy();
        expect(f.kind).toBeTruthy();
      }
    });
  }

  it("app-registration config has just a displayName field", async () => {
    const config = await getAzureCreateConfig(makeCtx(), "azure-app-registration");
    expect(config.fields.map((f) => f.key)).toEqual(["displayName"]);
  });

  it("resource-group config has name + region", async () => {
    const config = await getAzureCreateConfig(makeCtx(), "azure-resource-group");
    expect(config.fields.map((f) => f.key)).toEqual(["name", "region"]);
  });

  it("throws for an unsupported type", async () => {
    await expect(getAzureCreateConfig(makeCtx(), "azure-nope")).rejects.toThrow(
      /create not supported/,
    );
  });
});
