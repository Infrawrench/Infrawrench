import { describe, it, expect, vi } from "vitest";
import { createAzureResource } from "../create-dispatch.js";
import type { AzureCreateContext } from "../create-handlers-shared.js";
import { plugin } from "../plugin.js";

/**
 * Routing tests for the `createResource` dispatch: every type-id that
 * advertises `supportsCreate: true` must route to the right per-service
 * executor. We assert routing behaviorally — each executor PUTs to a
 * provider-specific ARM URL, so the recorded URL identifies the executor
 * (and, for the parameterized executors, verifies the provider path +
 * api-version the dispatch passes in).
 */
function makeCtx(): { ctx: AzureCreateContext; urls: string[] } {
  const urls: string[] = [];
  const record = async (url: string) => {
    urls.push(url);
    return { id: "/arm/id", properties: { provisioningState: "Creating" } };
  };
  const ctx = {
    get: vi.fn(async () => ({ value: [] })),
    post: vi.fn(record),
    put: vi.fn(record),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => undefined),
    makeId: (a: string, t: string, e: string) => `${a}:${t}:${e}`,
    graphClient: {} as never,
    subscriptionId: "sub1",
    tenantId: "t1",
    clientId: "c1",
    clientSecret: "s1",
  } as unknown as AzureCreateContext;
  return { ctx, urls };
}

const ACCT = "acct";
const BASE = { resourceGroup: "rg1", region: "eastus" };

const CASES: Array<{
  typeId: string;
  fields: Record<string, string>;
  /** Fragment of the ARM PUT URL that identifies the executor (+ api-version for parameterized ones) */
  urlFragment: string;
}> = [
  {
    typeId: "azure-vm",
    fields: {
      ...BASE,
      name: "vm1",
      size: "Standard_B1s",
      image: "Canonical:ubuntu:22:latest",
    },
    urlFragment: "/virtualMachines/vm1",
  },
  {
    typeId: "azure-aks-cluster",
    fields: {
      ...BASE,
      name: "k1",
      kubernetesVersion: "1.29",
      nodeSize: "Standard_D2s_v5",
      nodeCount: "3",
      osDiskSizeGb: "128",
    },
    urlFragment: "/managedClusters/k1",
  },
  {
    typeId: "azure-storage-account",
    fields: { ...BASE, name: "s1" },
    urlFragment: "Microsoft.Storage/storageAccounts/s1",
  },
  {
    typeId: "azure-cosmos-db",
    fields: { ...BASE, name: "c1" },
    urlFragment: "Microsoft.DocumentDB/databaseAccounts/c1",
  },
  {
    typeId: "azure-redis-cache",
    fields: { ...BASE, name: "r1", sku: "Basic", capacity: "0" },
    urlFragment: "Microsoft.Cache/redis/r1",
  },
  {
    typeId: "azure-postgres-flexible",
    fields: { ...BASE, name: "pg1", version: "16", sku: "Standard_B1ms", adminPassword: "p" },
    urlFragment: "Microsoft.DBforPostgreSQL/flexibleServers/pg1?api-version=2023-06-01-preview",
  },
  {
    typeId: "azure-mysql-flexible",
    fields: { ...BASE, name: "my1", version: "8.0.21", sku: "Standard_B1ms", adminPassword: "p" },
    urlFragment: "Microsoft.DBforMySQL/flexibleServers/my1?api-version=2023-06-30",
  },
  {
    typeId: "azure-log-analytics",
    fields: { ...BASE, name: "la1" },
    urlFragment: "Microsoft.OperationalInsights/workspaces/la1",
  },
  {
    typeId: "azure-managed-identity",
    fields: { ...BASE, name: "mi1" },
    urlFragment: "Microsoft.ManagedIdentity/userAssignedIdentities/mi1?api-version=2023-01-31",
  },
  {
    typeId: "azure-dns-zone",
    fields: { ...BASE, name: "example.com" },
    urlFragment: "Microsoft.Network/dnszones/example.com?api-version=2023-07-01-preview",
  },
  {
    typeId: "azure-vnet",
    fields: { ...BASE, name: "vn1" },
    urlFragment: "/virtualNetworks/vn1",
  },
  {
    typeId: "azure-nsg",
    fields: { ...BASE, name: "nsg1" },
    urlFragment: "Microsoft.Network/networkSecurityGroups/nsg1?api-version=2023-09-01",
  },
  {
    typeId: "azure-key-vault",
    fields: { ...BASE, name: "v1" },
    urlFragment: "Microsoft.KeyVault/vaults/v1",
  },
  {
    typeId: "azure-container-registry",
    fields: { ...BASE, name: "acr1" },
    urlFragment: "Microsoft.ContainerRegistry/registries/acr1",
  },
  {
    typeId: "azure-resource-group",
    fields: { name: "rg1", region: "eastus" },
    urlFragment: "/resourcegroups/rg1",
  },
  {
    typeId: "azure-container-instance",
    fields: { ...BASE, name: "ci1", image: "nginx" },
    urlFragment: "Microsoft.ContainerInstance/containerGroups/ci1",
  },
  {
    typeId: "azure-service-bus",
    fields: { ...BASE, name: "sb1" },
    urlFragment: "Microsoft.ServiceBus/namespaces/sb1?api-version=2022-10-01-preview",
  },
  {
    typeId: "azure-event-hub",
    fields: { ...BASE, name: "eh1" },
    urlFragment: "Microsoft.EventHub/namespaces/eh1?api-version=2022-10-01-preview",
  },
  {
    typeId: "azure-public-ip",
    fields: { ...BASE, name: "pip1" },
    urlFragment: "/publicIPAddresses/pip1",
  },
  {
    typeId: "azure-disk",
    fields: { ...BASE, name: "d1", sku: "Premium_LRS", diskSizeGb: "256" },
    urlFragment: "Microsoft.Compute/disks/d1",
  },
  {
    typeId: "azure-app-service",
    fields: { ...BASE, name: "app1" },
    urlFragment: "Microsoft.Web/sites/app1",
  },
  {
    typeId: "azure-function-app",
    fields: { ...BASE, name: "fn1", storageAccount: "rgS/sa1" },
    urlFragment: "Microsoft.Web/sites/fn1",
  },
  {
    typeId: "azure-sql-database",
    fields: {
      ...BASE,
      databaseName: "db1",
      serverName: "srv1",
      adminPassword: "pw",
      sku: "S0",
    },
    urlFragment: "/databases/db1",
  },
  {
    typeId: "azure-load-balancer",
    fields: { ...BASE, name: "lb1", sku: "Standard" },
    urlFragment: "Microsoft.Network/loadBalancers/lb1?api-version=2023-09-01",
  },
];

describe("createAzureResource dispatch", () => {
  it("covers every resource type that advertises supportsCreate", () => {
    const supportsCreate = plugin.resourceTypes
      .filter((rt) => rt.supportsCreate)
      .map((rt) => rt.id)
      .sort();
    const covered = [...CASES.map((c) => c.typeId), "azure-app-registration"].sort();
    expect(covered).toEqual(supportsCreate);
  });

  for (const { typeId, fields, urlFragment } of CASES) {
    it(`routes ${typeId} to its executor`, async () => {
      const { ctx, urls } = makeCtx();
      const out = await createAzureResource(ctx, typeId, ACCT, fields);
      expect(out.resourceTypeId).toBe(typeId);
      expect(out.pluginId).toBe("azure");
      expect(urls.some((u) => u.includes(urlFragment))).toBe(true);
    });
  }

  it('forces location "global" for azure-dns-zone (ARM rejects real regions)', async () => {
    const { ctx } = makeCtx();
    await createAzureResource(ctx, "azure-dns-zone", ACCT, { ...BASE, name: "example.com" });
    const put = (ctx.put as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((put[1] as { location: string }).location).toBe("global");
  });

  it("routes azure-app-registration to the Graph executor", async () => {
    const paths: string[] = [];
    const api = vi.fn((path: string) => {
      paths.push(path);
      if (path === "/applications") {
        return { post: vi.fn(async () => ({ id: "obj-1", appId: "app-1" })) };
      }
      return { post: vi.fn(async () => ({ id: "sp-1" })) };
    });
    const { ctx } = makeCtx();
    (ctx as { graphClient: unknown }).graphClient = { api };
    const out = await createAzureResource(ctx, "azure-app-registration", ACCT, {
      displayName: "My App",
    });
    expect(out.resourceTypeId).toBe("azure-app-registration");
    expect(paths).toContain("/applications");
    expect(paths).toContain("/servicePrincipals");
  });

  it("throws for an unsupported type", async () => {
    const { ctx } = makeCtx();
    await expect(createAzureResource(ctx, "azure-nope", ACCT, {})).rejects.toThrow(
      /createResource not supported/,
    );
  });
});
