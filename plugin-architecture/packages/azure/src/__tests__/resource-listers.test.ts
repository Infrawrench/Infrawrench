import { describe, it, expect, vi } from "vitest";
import * as listers from "../resource-listers.js";
import type { ListerContext } from "../resource-listers.js";

function makeCtx(getImpl: (url: string) => unknown): ListerContext {
  return {
    get: vi.fn(async (url: string) => getImpl(url)) as ListerContext["get"],
    post: vi.fn(async () => ({})) as ListerContext["post"],
    put: vi.fn(async () => ({})) as ListerContext["put"],
    del: vi.fn(async () => undefined),
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2024-01-01T00:00:00Z",
    subscriptionId: "sub1",
  };
}

const ACCT = "acct";

describe("listResourceGroups", () => {
  it("maps name/location/provisioningState and resourceId output", async () => {
    const ctx = makeCtx(() => ({
      value: [
        {
          id: "/subscriptions/sub1/resourceGroups/rg-a",
          name: "rg-a",
          location: "eastus",
          properties: { provisioningState: "Succeeded" },
        },
      ],
    }));
    const out = await listers.listResourceGroups(ctx, ACCT);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      resourceTypeId: "azure-resource-group",
      displayName: "rg-a",
      externalId: "rg-a",
      fields: { name: "rg-a", location: "eastus", provisioningState: "Succeeded" },
    });
    expect(out[0]!.resolvedOutputs["resourceId"]).toBe("/subscriptions/sub1/resourceGroups/rg-a");
  });

  it("handles a missing value array", async () => {
    const ctx = makeCtx(() => ({}));
    expect(await listers.listResourceGroups(ctx, ACCT)).toEqual([]);
  });
});

describe("listVMs", () => {
  const vmId =
    "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm1";

  it("extracts power state, image, and resolves NIC + public IP", async () => {
    const ctx = makeCtx((url) => {
      if (url.includes("virtualMachines?")) {
        return {
          value: [
            {
              id: vmId,
              name: "vm1",
              location: "eastus",
              properties: {
                hardwareProfile: { vmSize: "Standard_B1s" },
                provisioningState: "Succeeded",
                osProfile: { adminUsername: "azureuser" },
                storageProfile: {
                  osDisk: { osType: "Linux", diskSizeGB: 30 },
                  imageReference: { publisher: "Canonical", offer: "ubuntu", sku: "22" },
                },
                instanceView: {
                  statuses: [
                    { code: "PowerState/running", displayStatus: "VM running" },
                    { code: "ProvisioningState/succeeded" },
                  ],
                },
                networkProfile: { networkInterfaces: [{ id: "/nic1" }] },
                timeCreated: "2023-06-01T00:00:00Z",
              },
            },
          ],
        };
      }
      if (url.includes("/nic1")) {
        return {
          properties: {
            ipConfigurations: [
              {
                properties: {
                  privateIPAddress: "10.0.0.4",
                  publicIPAddress: { id: "/pip1" },
                },
              },
            ],
          },
        };
      }
      if (url.includes("/pip1")) {
        return { properties: { ipAddress: "1.2.3.4", dnsSettings: { fqdn: "vm1.example.com" } } };
      }
      return {};
    });
    const out = await listers.listVMs(ctx, ACCT);
    expect(out).toHaveLength(1);
    const vm = out[0]!;
    expect(vm.externalId).toBe("rg1/vm1");
    expect(vm.fields["powerState"]).toBe("VM running");
    expect(vm.fields["vmSize"]).toBe("Standard_B1s");
    expect(vm.fields["imageReference"]).toBe("Canonical/ubuntu/22");
    expect(vm.fields["sshUsername"]).toBe("azureuser");
    expect(vm.resolvedOutputs).toMatchObject({
      privateIp: "10.0.0.4",
      publicIp: "1.2.3.4",
      fqdn: "vm1.example.com",
    });
    expect(vm.createdAt).toBe("2023-06-01T00:00:00Z");
  });

  it("tolerates a NIC fetch failure (catch branch)", async () => {
    const ctx = makeCtx((url) => {
      if (url.includes("virtualMachines?")) {
        return {
          value: [
            {
              id: vmId,
              name: "vm1",
              properties: { networkProfile: { networkInterfaces: [{ id: "/nicX" }] } },
            },
          ],
        };
      }
      throw new Error("nic boom");
    });
    const out = await listers.listVMs(ctx, ACCT);
    expect(out[0]!.resolvedOutputs).toMatchObject({ publicIp: "", privateIp: "", fqdn: "" });
  });

  it("tolerates a public IP fetch failure (inner catch)", async () => {
    const ctx = makeCtx((url) => {
      if (url.includes("virtualMachines?")) {
        return {
          value: [
            {
              id: vmId,
              name: "vm1",
              properties: { networkProfile: { networkInterfaces: [{ id: "/nic1" }] } },
            },
          ],
        };
      }
      if (url.includes("/nic1")) {
        return {
          properties: {
            ipConfigurations: [
              { properties: { privateIPAddress: "10.0.0.4", publicIPAddress: { id: "/pipX" } } },
            ],
          },
        };
      }
      throw new Error("pip boom");
    });
    const out = await listers.listVMs(ctx, ACCT);
    expect(out[0]!.resolvedOutputs["privateIp"]).toBe("10.0.0.4");
    expect(out[0]!.resolvedOutputs["publicIp"]).toBe("");
  });

  it("handles a VM with no NICs", async () => {
    const ctx = makeCtx(() => ({ value: [{ id: vmId, name: "vm1", properties: {} }] }));
    const out = await listers.listVMs(ctx, ACCT);
    expect(out[0]!.resolvedOutputs).toMatchObject({ publicIp: "", privateIp: "", fqdn: "" });
  });
});

describe("listDisks", () => {
  it("maps sku, size, managedBy short name", async () => {
    const ctx = makeCtx(() => ({
      value: [
        {
          id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Compute/disks/d1",
          name: "d1",
          location: "eastus",
          sku: { name: "Premium_LRS" },
          properties: {
            diskSizeGB: 64,
            diskState: "Attached",
            osType: "Linux",
            managedBy: "/subscriptions/x/.../virtualMachines/vm9",
            encryption: { type: "EncryptionAtRestWithPlatformKey" },
          },
        },
      ],
    }));
    const out = await listers.listDisks(ctx, ACCT);
    expect(out[0]!.fields).toMatchObject({
      sku: "Premium_LRS",
      diskSizeGb: 64,
      managedBy: "vm9",
      encryption: "EncryptionAtRestWithPlatformKey",
    });
  });
});

describe("listVNets", () => {
  it("joins prefixes and counts subnets", async () => {
    const ctx = makeCtx(() => ({
      value: [
        {
          id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/virtualNetworks/vn1",
          name: "vn1",
          location: "eastus",
          properties: {
            addressSpace: { addressPrefixes: ["10.0.0.0/16", "10.1.0.0/16"] },
            subnets: [{}, {}],
            provisioningState: "Succeeded",
          },
        },
      ],
    }));
    const out = await listers.listVNets(ctx, ACCT);
    expect(out[0]!.fields["addressPrefixes"]).toBe("10.0.0.0/16, 10.1.0.0/16");
    expect(out[0]!.fields["subnetCount"]).toBe(2);
  });
});

describe("listSubnets", () => {
  it("expands subnets from virtual networks", async () => {
    const ctx = makeCtx(() => ({
      value: [
        {
          id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/virtualNetworks/vn1",
          name: "vn1",
          location: "eastus",
          properties: {
            subnets: [
              {
                id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/virtualNetworks/vn1/subnets/default",
                name: "default",
                properties: {
                  addressPrefix: "10.0.0.0/24",
                  provisioningState: "Succeeded",
                  routeTable: { id: "/routeTables/rt1" },
                  natGateway: { id: "/natGateways/nat1" },
                  networkSecurityGroup: { id: "/networkSecurityGroups/nsg1" },
                },
              },
            ],
          },
        },
      ],
    }));
    const out = await listers.listSubnets(ctx, ACCT);
    expect(out[0]).toMatchObject({
      resourceTypeId: "azure-subnet",
      displayName: "vn1/default",
      externalId: "rg1/vn1/default",
      fields: {
        vnetName: "vn1",
        addressPrefix: "10.0.0.0/24",
        routeTable: "rt1",
        natGateway: "nat1",
        networkSecurityGroup: "nsg1",
      },
    });
  });
});

describe("listAKSClusters", () => {
  it("sums node counts and reads pool/network info", async () => {
    const ctx = makeCtx(() => ({
      value: [
        {
          id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.ContainerService/managedClusters/k1",
          name: "k1",
          location: "eastus",
          sku: { tier: "Standard" },
          properties: {
            kubernetesVersion: "1.29",
            provisioningState: "Succeeded",
            powerState: { code: "Running" },
            agentPoolProfiles: [
              { count: 3, vmSize: "Standard_D2s_v5", osDiskSizeGB: 128 },
              { count: 2 },
            ],
            networkProfile: { networkPlugin: "azure" },
            fqdn: "k1.hcp.eastus.azmk8s.io",
          },
        },
      ],
    }));
    const out = await listers.listAKSClusters(ctx, ACCT);
    expect(out[0]!.fields["nodeCount"]).toBe(5);
    expect(out[0]!.fields["nodePoolCount"]).toBe(2);
    expect(out[0]!.fields["tier"]).toBe("Standard");
    expect(out[0]!.resolvedOutputs["fqdn"]).toBe("k1.hcp.eastus.azmk8s.io");
  });
});

describe("listSQLDatabases", () => {
  it("lists dbs per server, skips master, builds connection string", async () => {
    const ctx = makeCtx((url) => {
      if (url.includes("/servers?")) {
        return {
          value: [
            {
              id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Sql/servers/srv1",
              name: "srv1",
              properties: { fullyQualifiedDomainName: "srv1.database.windows.net" },
            },
          ],
        };
      }
      if (url.includes("/databases?")) {
        return {
          value: [
            { name: "master", properties: {} },
            { name: "appdb", location: "eastus", properties: { status: "Online" } },
          ],
        };
      }
      return {};
    });
    const out = await listers.listSQLDatabases(ctx, ACCT);
    expect(out).toHaveLength(1);
    expect(out[0]!.externalId).toBe("rg1/srv1/appdb");
    expect(out[0]!.resolvedOutputs["connectionString"]).toContain("srv1.database.windows.net");
  });

  it("skips servers whose database list fails", async () => {
    const ctx = makeCtx((url) => {
      if (url.includes("/servers?")) {
        return { value: [{ id: "/x/resourceGroups/rg1/.../servers/srv1", name: "srv1" }] };
      }
      throw new Error("db list failed");
    });
    expect(await listers.listSQLDatabases(ctx, ACCT)).toEqual([]);
  });
});

describe("simple ARM list mappers", () => {
  const cases: Array<{
    name: string;
    fn: (ctx: ListerContext, a: string) => Promise<unknown[]>;
    urlPart: string;
    item: Record<string, unknown>;
    expectField: [string, unknown];
  }> = [
    {
      name: "listCosmosDBAccounts",
      fn: listers.listCosmosDBAccounts,
      urlPart: "databaseAccounts",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.DocumentDB/databaseAccounts/c1",
        name: "c1",
        kind: "MongoDB",
        properties: {
          consistencyPolicy: { defaultConsistencyLevel: "Session" },
          readLocations: [{ locationName: "eastus" }],
          writeLocations: [{ locationName: "eastus" }],
          documentEndpoint: "https://c1.documents.azure.com/",
        },
      },
      expectField: ["consistencyLevel", "Session"],
    },
    {
      name: "listStorageAccounts",
      fn: listers.listStorageAccounts,
      urlPart: "storageAccounts",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Storage/storageAccounts/s1",
        name: "s1",
        location: "eastus",
        kind: "StorageV2",
        sku: { name: "Standard_LRS" },
        properties: { primaryEndpoints: { blob: "https://s1.blob/" }, accessTier: "Hot" },
      },
      expectField: ["sku", "Standard_LRS"],
    },
    {
      name: "listKeyVaults",
      fn: listers.listKeyVaults,
      urlPart: "vaults",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.KeyVault/vaults/v1",
        name: "v1",
        properties: { sku: { name: "standard" }, vaultUri: "https://v1.vault.azure.net/" },
      },
      expectField: ["sku", "standard"],
    },
    {
      name: "listRedisCaches",
      fn: listers.listRedisCaches,
      urlPart: "Microsoft.Cache/redis",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Cache/redis/r1",
        name: "r1",
        properties: { sku: { name: "Basic", capacity: 1 }, hostName: "r1.redis", sslPort: 6380 },
      },
      expectField: ["sku", "Basic"],
    },
    {
      name: "listServiceBusNamespaces",
      fn: listers.listServiceBusNamespaces,
      urlPart: "Microsoft.ServiceBus/namespaces",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.ServiceBus/namespaces/sb1",
        name: "sb1",
        sku: { name: "Standard" },
        properties: { serviceBusEndpoint: "https://sb1.servicebus.windows.net/" },
      },
      expectField: ["sku", "Standard"],
    },
    {
      name: "listContainerRegistries",
      fn: listers.listContainerRegistries,
      urlPart: "registries",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.ContainerRegistry/registries/acr1",
        name: "acr1",
        sku: { name: "Basic" },
        properties: { loginServer: "acr1.azurecr.io", adminUserEnabled: true },
      },
      expectField: ["adminEnabled", true],
    },
    {
      name: "listRouteTables",
      fn: listers.listRouteTables,
      urlPart: "routeTables",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/routeTables/rt1",
        name: "rt1",
        location: "eastus",
        properties: { provisioningState: "Succeeded", routes: [{}, {}], subnets: [{}] },
      },
      expectField: ["routeCount", 2],
    },
    {
      name: "listNatGateways",
      fn: listers.listNatGateways,
      urlPart: "natGateways",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/natGateways/nat1",
        name: "nat1",
        location: "eastus",
        sku: { name: "Standard" },
        properties: {
          provisioningState: "Succeeded",
          idleTimeoutInMinutes: 8,
          publicIpAddresses: [{}],
          subnets: [{}, {}],
        },
      },
      expectField: ["subnetCount", 2],
    },
    {
      name: "listLoadBalancers",
      fn: listers.listLoadBalancers,
      urlPart: "loadBalancers",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/loadBalancers/lb1",
        name: "lb1",
        sku: { name: "Standard" },
        properties: {
          frontendIPConfigurations: [{ properties: { privateIPAddress: "10.0.0.5" } }],
          backendAddressPools: [{}],
          loadBalancingRules: [{}, {}],
        },
      },
      expectField: ["ruleCount", 2],
    },
    {
      name: "listDNSZones",
      fn: listers.listDNSZones,
      urlPart: "dnsZones",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/dnszones/z1",
        name: "z1",
        properties: { zoneType: "Public", numberOfRecordSets: 5, nameServers: ["ns1", "ns2"] },
      },
      expectField: ["numberOfRecordSets", 5],
    },
    {
      name: "listPrivateDNSZones",
      fn: listers.listPrivateDNSZones,
      urlPart: "privateDnsZones",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/privateDnsZones/privatelink.database.windows.net",
        name: "privatelink.database.windows.net",
        properties: {
          numberOfRecordSets: 5,
          maxNumberOfRecordSets: 25000,
          numberOfVirtualNetworkLinks: 2,
        },
      },
      expectField: ["virtualNetworkLinkCount", 2],
    },
    {
      name: "listNSGs",
      fn: listers.listNSGs,
      urlPart: "networkSecurityGroups",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/networkSecurityGroups/nsg1",
        name: "nsg1",
        properties: { securityRules: [{}, {}], subnets: [{}], networkInterfaces: [] },
      },
      expectField: ["securityRuleCount", 2],
    },
    {
      name: "listPublicIPs",
      fn: listers.listPublicIPs,
      urlPart: "publicIPAddresses",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/publicIPAddresses/pip1",
        name: "pip1",
        sku: { name: "Standard" },
        properties: {
          publicIPAllocationMethod: "Static",
          ipAddress: "1.2.3.4",
          dnsSettings: { fqdn: "pip1.example.com" },
        },
      },
      expectField: ["allocationMethod", "Static"],
    },
    {
      name: "listPostgresFlexibleServers",
      fn: listers.listPostgresFlexibleServers,
      urlPart: "Microsoft.DBforPostgreSQL/flexibleServers",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg1",
        name: "pg1",
        sku: { name: "Standard_B1ms", tier: "Burstable" },
        properties: {
          version: "16",
          storage: { storageSizeGB: 32 },
          highAvailability: { mode: "ZoneRedundant" },
          backup: { backupRetentionDays: 14 },
          fullyQualifiedDomainName: "pg1.postgres.database.azure.com",
          administratorLogin: "pgadmin",
        },
      },
      expectField: ["haEnabled", true],
    },
    {
      name: "listMySQLFlexibleServers",
      fn: listers.listMySQLFlexibleServers,
      urlPart: "Microsoft.DBforMySQL/flexibleServers",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.DBforMySQL/flexibleServers/my1",
        name: "my1",
        sku: { name: "Standard_E2ds", tier: "MemoryOptimized" },
        properties: {
          version: "8.0.21",
          storage: { storageSizeGB: 64 },
          highAvailability: { mode: "Disabled" },
        },
      },
      expectField: ["haEnabled", false],
    },
    {
      name: "listEventHubNamespaces",
      fn: listers.listEventHubNamespaces,
      urlPart: "Microsoft.EventHub/namespaces",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.EventHub/namespaces/eh1",
        name: "eh1",
        sku: { name: "Standard" },
        properties: { isAutoInflateEnabled: true, maximumThroughputUnits: 10 },
      },
      expectField: ["maximumThroughputUnits", 10],
    },
    {
      name: "listAppGateways",
      fn: listers.listAppGateways,
      urlPart: "applicationGateways",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/applicationGateways/gw1",
        name: "gw1",
        properties: {
          sku: { name: "Standard_v2", tier: "Standard_v2", capacity: 2 },
          backendAddressPools: [{}],
          httpListeners: [{}, {}],
          frontendIPConfigurations: [{ properties: { privateIPAddress: "10.0.0.9" } }],
        },
      },
      expectField: ["httpListenerCount", 2],
    },
    {
      name: "listLogAnalyticsWorkspaces",
      fn: listers.listLogAnalyticsWorkspaces,
      urlPart: "OperationalInsights/workspaces",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.OperationalInsights/workspaces/la1",
        name: "la1",
        location: "eastus",
        properties: {
          sku: { name: "PerGB2018" },
          retentionInDays: 90,
          workspaceCapping: { dailyQuotaGb: 5 },
          customerId: "cust-id",
        },
      },
      expectField: ["retentionInDays", 90],
    },
    {
      name: "listManagedIdentities",
      fn: listers.listManagedIdentities,
      urlPart: "ManagedIdentity/userAssignedIdentities",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mi1",
        name: "mi1",
        location: "eastus",
        properties: { clientId: "cid", principalId: "pid", tenantId: "tid" },
      },
      expectField: ["name", "mi1"],
    },
    {
      name: "listFirewalls",
      fn: listers.listFirewalls,
      urlPart: "azureFirewalls",
      item: {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/azureFirewalls/fw1",
        name: "fw1",
        location: "eastus",
        properties: {
          sku: { name: "AZFW_VNet", tier: "Standard" },
          threatIntelMode: "Alert",
          ipConfigurations: [{ properties: { privateIPAddress: "10.0.0.10" } }],
        },
      },
      expectField: ["threatIntelMode", "Alert"],
    },
  ];

  for (const c of cases) {
    it(`${c.name} maps fields`, async () => {
      const ctx = makeCtx(() => ({ value: [c.item] }));
      const out = (await c.fn(ctx, ACCT)) as Array<{ fields: Record<string, unknown> }>;
      expect(out).toHaveLength(1);
      expect(out[0]!.fields[c.expectField[0]]).toEqual(c.expectField[1]);
    });

    it(`${c.name} handles empty results`, async () => {
      const ctx = makeCtx(() => ({}));
      expect(await c.fn(ctx, ACCT)).toEqual([]);
    });
  }
});

describe("function-app vs app-service filtering by kind", () => {
  const sites = {
    value: [
      {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Web/sites/fn1",
        name: "fn1",
        kind: "functionapp,linux",
        properties: { state: "Running", siteConfig: { linuxFxVersion: "node|20" } },
      },
      {
        id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Web/sites/web1",
        name: "web1",
        kind: "app,linux",
        properties: { state: "Running", siteConfig: { linuxFxVersion: "PHP|8" } },
      },
    ],
  };

  it("listFunctionApps keeps only functionapp kinds", async () => {
    const ctx = makeCtx(() => sites);
    const out = await listers.listFunctionApps(ctx, ACCT);
    expect(out.map((r) => r.displayName)).toEqual(["fn1"]);
  });

  it("listAppServices excludes functionapp kinds", async () => {
    const ctx = makeCtx(() => sites);
    const out = await listers.listAppServices(ctx, ACCT);
    expect(out.map((r) => r.displayName)).toEqual(["web1"]);
  });
});

describe("listAppServicePlans", () => {
  const planId = "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Web/serverfarms/plan1";

  it("maps sku, worker/site counts and the rg/name external id", async () => {
    const urls: string[] = [];
    const ctx = makeCtx(() => ({
      value: [
        {
          id: planId,
          name: "plan1",
          type: "Microsoft.Web/serverfarms",
          kind: "linux",
          location: "East US",
          properties: {
            status: "Ready",
            maximumNumberOfWorkers: 20,
            numberOfWorkers: 3,
            numberOfSites: 4,
            reserved: true,
            provisioningState: "Succeeded",
          },
          sku: { name: "P1v3", tier: "PremiumV3", size: "P1v3", family: "Pv3", capacity: 3 },
        },
      ],
    }));
    const spy = ctx.get as unknown as { mock: { calls: [string][] } };
    const out = await listers.listAppServicePlans(ctx, ACCT);
    urls.push(...spy.mock.calls.map((c) => c[0]));

    expect(urls).toEqual([
      "https://management.azure.com/subscriptions/sub1/providers/Microsoft.Web/serverfarms?api-version=2023-01-01",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      resourceTypeId: "azure-app-service-plan",
      displayName: "plan1",
      externalId: "rg1/plan1",
      fields: {
        name: "plan1",
        resourceGroup: "rg1",
        location: "East US",
        kind: "linux",
        sku: "P1v3",
        tier: "PremiumV3",
        size: "P1v3",
        capacity: 3,
        workerCount: 3,
        maximumWorkers: 20,
        operatingSystem: "Linux",
        siteCount: 4,
        status: "Ready",
        provisioningState: "Succeeded",
      },
    });
    expect(out[0]!.resolvedOutputs["resourceId"]).toBe(planId);
  });

  it("reports Windows when `reserved` is absent or false", async () => {
    const ctx = makeCtx(() => ({
      value: [{ id: planId, name: "plan1", properties: { status: "Ready" }, sku: { name: "S1" } }],
    }));
    const out = await listers.listAppServicePlans(ctx, ACCT);
    expect(out[0]!.fields["operatingSystem"]).toBe("Windows");
    expect(out[0]!.fields["siteCount"]).toBe(0);
  });

  it("handles a missing value array", async () => {
    const ctx = makeCtx(() => ({}));
    expect(await listers.listAppServicePlans(ctx, ACCT)).toEqual([]);
  });
});

describe("listContainerInstances", () => {
  it("maps container count and ip address", async () => {
    const ctx = makeCtx(() => ({
      value: [
        {
          id: "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.ContainerInstance/containerGroups/ci1",
          name: "ci1",
          location: "eastus",
          properties: {
            osType: "Linux",
            restartPolicy: "Always",
            containers: [{}],
            ipAddress: { ip: "1.2.3.4", fqdn: "ci1.eastus.azurecontainer.io" },
            provisioningState: "Succeeded",
          },
        },
      ],
    }));
    const out = await listers.listContainerInstances(ctx, ACCT);
    expect(out[0]!.fields["containers"]).toBe(1);
    expect(out[0]!.resolvedOutputs["ipAddress"]).toBe("1.2.3.4");
  });
});
