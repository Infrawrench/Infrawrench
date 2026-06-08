import { describe, it, expect, vi } from "vitest";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { buildAzureDashboardStats } from "../dashboard-stats.js";
import { deleteAzureResource } from "../delete-handlers.js";
import { attachAzureResource } from "../attach-handlers.js";
import { getAzureManifest, applyAzureManifest } from "../manifest.js";
import { exportAzureCredential } from "../export-credential.js";
import { publishServiceBus, publishEventHub } from "../publish-handlers.js";

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

function httpCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => undefined),
    subscriptionId: "sub1",
    tenantId: "t1",
    ...overrides,
  };
}

// ─── dashboard-stats ──────────────────────────────────────────────────────

describe("buildAzureDashboardStats", () => {
  it("VM running shows healthy status + public IP", () => {
    const stats = buildAzureDashboardStats(
      res({
        resourceTypeId: "azure-vm",
        fields: { state: "Running", location: "eastus" },
        resolvedOutputs: { publicIp: "1.2.3.4" },
      }),
    );
    expect(stats[0]).toMatchObject({ label: "State", value: "Running", variant: "status-healthy" });
    expect(stats.find((s) => s.label === "Public IP")?.value).toBe("1.2.3.4");
  });

  it("VM deallocated maps to error", () => {
    const stats = buildAzureDashboardStats(
      res({ resourceTypeId: "azure-vm", fields: { state: "Deallocated" } }),
    );
    expect(stats[0]!.variant).toBe("status-error");
  });

  it("VM unknown state maps to degraded and omits public IP", () => {
    const stats = buildAzureDashboardStats(res({ resourceTypeId: "azure-vm", fields: {} }));
    expect(stats[0]!.variant).toBe("status-degraded");
    expect(stats.find((s) => s.label === "Public IP")).toBeUndefined();
  });

  it("AKS shows version/location/nodes", () => {
    const stats = buildAzureDashboardStats(
      res({
        resourceTypeId: "azure-aks-cluster",
        fields: { version: "1.29", location: "eastus", nodeCount: 3 },
      }),
    );
    expect(stats.map((s) => s.label)).toEqual(["Version", "Location", "Nodes"]);
  });

  it("SQL database online maps to healthy", () => {
    const stats = buildAzureDashboardStats(
      res({ resourceTypeId: "azure-sql-database", fields: { status: "Online" } }),
    );
    expect(stats[0]!.variant).toBe("status-healthy");
  });

  it("generic fallback derives status/type/region variants", () => {
    const healthy = buildAzureDashboardStats(
      res({
        resourceTypeId: "azure-storage-account",
        fields: { provisioningState: "Succeeded", sku: "Standard_LRS", location: "eastus" },
      }),
    );
    expect(healthy[0]).toMatchObject({ label: "Status", variant: "status-healthy" });
    expect(healthy.find((s) => s.label === "Type")?.value).toBe("Standard_LRS");
    expect(healthy.find((s) => s.label === "Region")?.value).toBe("eastus");

    const failed = buildAzureDashboardStats(
      res({ resourceTypeId: "azure-redis-cache", fields: { state: "Failed" } }),
    );
    expect(failed[0]!.variant).toBe("status-error");

    const degraded = buildAzureDashboardStats(
      res({ resourceTypeId: "azure-redis-cache", fields: { state: "Creating" } }),
    );
    expect(degraded[0]!.variant).toBe("status-degraded");

    const def = buildAzureDashboardStats(
      res({ resourceTypeId: "azure-redis-cache", fields: { state: "Weird" } }),
    );
    expect(def[0]!.variant).toBe("default");

    const empty = buildAzureDashboardStats(
      res({ resourceTypeId: "azure-redis-cache", fields: {} }),
    );
    expect(empty).toEqual([]);
  });
});

// ─── delete-handlers ────────────────────────────────────────────────────────

describe("deleteAzureResource", () => {
  it("deletes a resource group with the no-provider URL", async () => {
    const del = vi.fn(async () => undefined);
    const ctx = {
      ...httpCtx({ del }),
      getResource: vi.fn(async () =>
        res({ resourceTypeId: "azure-resource-group", externalId: "rg1" }),
      ),
      graphClient: {} as never,
    };
    await deleteAzureResource(ctx as never, "azure-resource-group", "id", "acct");
    expect(del).toHaveBeenCalledWith(
      "https://management.azure.com/subscriptions/sub1/resourcegroups/rg1?api-version=2022-09-01",
    );
  });

  it("deletes a SQL database using the three-part externalId", async () => {
    const del = vi.fn(async (_url: string) => undefined);
    const ctx = {
      ...httpCtx({ del }),
      getResource: vi.fn(async () =>
        res({ resourceTypeId: "azure-sql-database", externalId: "rg1/srv1/db1" }),
      ),
      graphClient: {} as never,
    };
    await deleteAzureResource(ctx as never, "azure-sql-database", "id", "acct");
    expect(del.mock.calls[0]![0]).toContain("/servers/srv1/databases/db1");
  });

  it("deletes a standard rg/name resource", async () => {
    const del = vi.fn(async (_url: string) => undefined);
    const ctx = {
      ...httpCtx({ del }),
      getResource: vi.fn(async () => res({ resourceTypeId: "azure-vm", externalId: "rg1/vm1" })),
      graphClient: {} as never,
    };
    await deleteAzureResource(ctx as never, "azure-vm", "id", "acct");
    expect(del.mock.calls[0]![0]).toContain(
      "/providers/Microsoft.Compute/virtualMachines/vm1?api-version=2024-03-01",
    );
  });

  it("deletes an app registration via Graph", async () => {
    const deleteApi = vi.fn(async () => undefined);
    const api = vi.fn(() => ({ delete: deleteApi }));
    const ctx = {
      ...httpCtx(),
      getResource: vi.fn(async () =>
        res({ resourceTypeId: "azure-app-registration", externalId: "obj-1" }),
      ),
      graphClient: { api } as never,
    };
    await deleteAzureResource(ctx as never, "azure-app-registration", "id", "acct");
    expect(api).toHaveBeenCalledWith("/applications/obj-1");
    expect(deleteApi).toHaveBeenCalled();
  });

  it("throws when app registration object id missing", async () => {
    const ctx = {
      ...httpCtx(),
      getResource: vi.fn(async () =>
        res({ resourceTypeId: "azure-app-registration", externalId: "", fields: {} }),
      ),
      graphClient: { api: vi.fn() } as never,
    };
    await expect(
      deleteAzureResource(ctx as never, "azure-app-registration", "id", "acct"),
    ).rejects.toThrow(/object id/);
  });

  it("throws on unsupported type", async () => {
    const ctx = {
      ...httpCtx(),
      getResource: vi.fn(async () => res({ resourceTypeId: "azure-weird", externalId: "x" })),
      graphClient: {} as never,
    };
    await expect(deleteAzureResource(ctx as never, "azure-weird", "id", "acct")).rejects.toThrow(
      /delete not supported/,
    );
  });
});

// ─── attach-handlers ──────────────────────────────────────────────────────

describe("attachAzureResource", () => {
  const disk = res({
    resourceTypeId: "azure-disk",
    fields: { name: "d1", resourceGroup: "rg1", location: "eastus" },
  });
  const vm = res({
    resourceTypeId: "azure-vm",
    fields: { name: "vm1", resourceGroup: "rg1", location: "eastus" },
  });

  it("attaches a disk to a VM at the next free LUN", async () => {
    const patch = vi.fn(async (_url: string, _body: unknown) => ({}));
    const get = vi.fn(async () => ({
      properties: { storageProfile: { dataDisks: [{ lun: 0 }, { lun: 1 }] } },
    }));
    const ctx = {
      ...httpCtx({ get, patch }),
      getResource: vi.fn(async (t: string) => (t === "azure-disk" ? disk : vm)),
    };
    await attachAzureResource(ctx as never, "azure-disk", "ds", "azure-vm", "vms", "acct");
    const body = patch.mock.calls[0]![1] as {
      properties: { storageProfile: { dataDisks: Array<{ lun: number }> } };
    };
    const dataDisks = body.properties.storageProfile.dataDisks;
    expect(dataDisks[dataDisks.length - 1]!.lun).toBe(2);
  });

  it("rejects a disk in a different region", async () => {
    const ctx = {
      ...httpCtx(),
      getResource: vi.fn(async (t: string) =>
        t === "azure-disk"
          ? res({
              resourceTypeId: "azure-disk",
              fields: { location: "westus", name: "d", resourceGroup: "rg" },
            })
          : vm,
      ),
    };
    await expect(
      attachAzureResource(ctx as never, "azure-disk", "ds", "azure-vm", "vms", "acct"),
    ).rejects.toThrow(/does not match VM location/);
  });

  it("attaches an NSG to the primary NIC", async () => {
    const nsg = res({
      resourceTypeId: "azure-nsg",
      fields: { name: "nsg1", resourceGroup: "rg1", location: "eastus" },
    });
    const patch = vi.fn(async (_url: string, _body: unknown) => ({}));
    const get = vi.fn(async (url: string) => {
      if (url.includes("virtualMachines")) {
        return {
          properties: {
            networkProfile: {
              networkInterfaces: [{ id: "/nic1", properties: { primary: true } }],
            },
          },
        };
      }
      return { properties: { ipConfigurations: [] } };
    });
    const ctx = {
      ...httpCtx({ get, patch }),
      getResource: vi.fn(async (t: string) => (t === "azure-nsg" ? nsg : vm)),
    };
    await attachAzureResource(ctx as never, "azure-nsg", "ns", "azure-vm", "vms", "acct");
    const body = patch.mock.calls[0]![1] as {
      properties: { networkSecurityGroup: { id: string } };
    };
    expect(body.properties.networkSecurityGroup.id).toContain("/networkSecurityGroups/nsg1");
  });

  it("attaches a public IP to the primary NIC IP configuration", async () => {
    const pip = res({
      resourceTypeId: "azure-public-ip",
      fields: { name: "pip1", resourceGroup: "rg1", location: "eastus" },
    });
    const patch = vi.fn(async (_url: string, _body: unknown) => ({}));
    const get = vi.fn(async (url: string) => {
      if (url.includes("virtualMachines")) {
        return {
          properties: {
            networkProfile: {
              networkInterfaces: [{ id: "/nic1", properties: { primary: true } }],
            },
          },
        };
      }
      return {
        properties: {
          ipConfigurations: [{ name: "ipconfig1", properties: { primary: true } }],
        },
      };
    });
    const ctx = {
      ...httpCtx({ get, patch }),
      getResource: vi.fn(async (t: string) => (t === "azure-public-ip" ? pip : vm)),
    };
    await attachAzureResource(ctx as never, "azure-public-ip", "pip", "azure-vm", "vms", "acct");
    const body = patch.mock.calls[0]![1] as {
      properties: {
        ipConfigurations: Array<{ properties: { publicIPAddress: { id: string } } }>;
      };
    };
    expect(body.properties.ipConfigurations[0]!.properties.publicIPAddress.id).toContain(
      "/publicIPAddresses/pip1",
    );
  });

  it("adds a VM NIC IP configuration to a load balancer backend pool", async () => {
    const lb = res({
      resourceTypeId: "azure-load-balancer",
      displayName: "lb1",
      fields: { name: "lb1", resourceGroup: "rg1", location: "eastus" },
    });
    const patch = vi.fn(async (_url: string, _body: unknown) => ({}));
    const get = vi.fn(async (url: string) => {
      if (url.includes("loadBalancers")) {
        return {
          properties: {
            backendAddressPools: [{ id: "/lb/backendAddressPools/pool1" }],
          },
        };
      }
      if (url.includes("virtualMachines")) {
        return {
          properties: {
            networkProfile: {
              networkInterfaces: [{ id: "/nic1", properties: { primary: true } }],
            },
          },
        };
      }
      return {
        properties: {
          ipConfigurations: [
            {
              name: "ipconfig1",
              properties: {
                primary: true,
                loadBalancerBackendAddressPools: [{ id: "/lb/backendAddressPools/existing" }],
              },
            },
          ],
        },
      };
    });
    const ctx = {
      ...httpCtx({ get, patch }),
      getResource: vi.fn(async (t: string) => (t === "azure-load-balancer" ? lb : vm)),
    };
    await attachAzureResource(ctx as never, "azure-load-balancer", "lb", "azure-vm", "vms", "acct");
    const body = patch.mock.calls[0]![1] as {
      properties: {
        ipConfigurations: Array<{
          properties: { loadBalancerBackendAddressPools: Array<{ id: string }> };
        }>;
      };
    };
    expect(
      body.properties.ipConfigurations[0]!.properties.loadBalancerBackendAddressPools.map(
        (ref) => ref.id,
      ),
    ).toEqual(["/lb/backendAddressPools/existing", "/lb/backendAddressPools/pool1"]);
  });

  it("adds a VM NIC IP configuration to an application gateway backend pool", async () => {
    const gw = res({
      resourceTypeId: "azure-app-gateway",
      displayName: "gw1",
      fields: { name: "gw1", resourceGroup: "rg1", location: "eastus" },
    });
    const patch = vi.fn(async (_url: string, _body: unknown) => ({}));
    const get = vi.fn(async (url: string) => {
      if (url.includes("applicationGateways")) {
        return {
          properties: {
            backendAddressPools: [{ id: "/gw/backendAddressPools/pool1" }],
          },
        };
      }
      if (url.includes("virtualMachines")) {
        return {
          properties: {
            networkProfile: {
              networkInterfaces: [{ id: "/nic1", properties: { primary: true } }],
            },
          },
        };
      }
      return {
        properties: {
          ipConfigurations: [{ name: "ipconfig1", properties: { primary: true } }],
        },
      };
    });
    const ctx = {
      ...httpCtx({ get, patch }),
      getResource: vi.fn(async (t: string) => (t === "azure-app-gateway" ? gw : vm)),
    };
    await attachAzureResource(ctx as never, "azure-app-gateway", "gw", "azure-vm", "vms", "acct");
    const body = patch.mock.calls[0]![1] as {
      properties: {
        ipConfigurations: Array<{
          properties: { applicationGatewayBackendAddressPools: Array<{ id: string }> };
        }>;
      };
    };
    expect(
      body.properties.ipConfigurations[0]!.properties.applicationGatewayBackendAddressPools,
    ).toEqual([{ id: "/gw/backendAddressPools/pool1" }]);
  });

  it("does not duplicate an existing load balancer backend pool reference", async () => {
    const lb = res({
      resourceTypeId: "azure-load-balancer",
      displayName: "lb1",
      fields: { name: "lb1", resourceGroup: "rg1", location: "eastus" },
    });
    const patch = vi.fn(async (_url: string, _body: unknown) => ({}));
    const get = vi.fn(async (url: string) => {
      if (url.includes("loadBalancers")) {
        return { properties: { backendAddressPools: [{ id: "/lb/backendAddressPools/pool1" }] } };
      }
      if (url.includes("virtualMachines")) {
        return {
          properties: {
            networkProfile: { networkInterfaces: [{ id: "/nic1", properties: { primary: true } }] },
          },
        };
      }
      return {
        properties: {
          ipConfigurations: [
            {
              properties: {
                primary: true,
                loadBalancerBackendAddressPools: [{ id: "/lb/backendAddressPools/pool1" }],
              },
            },
          ],
        },
      };
    });
    const ctx = {
      ...httpCtx({ get, patch }),
      getResource: vi.fn(async (t: string) => (t === "azure-load-balancer" ? lb : vm)),
    };
    await attachAzureResource(ctx as never, "azure-load-balancer", "lb", "azure-vm", "vms", "acct");
    const body = patch.mock.calls[0]![1] as {
      properties: {
        ipConfigurations: Array<{
          properties: { loadBalancerBackendAddressPools: Array<{ id: string }> };
        }>;
      };
    };
    expect(body.properties.ipConfigurations[0]!.properties.loadBalancerBackendAddressPools).toEqual(
      [{ id: "/lb/backendAddressPools/pool1" }],
    );
  });

  it("associates a route table with a subnet", async () => {
    const routeTable = res({
      resourceTypeId: "azure-route-table",
      fields: { name: "rt1", resourceGroup: "rg1", location: "eastus" },
      resolvedOutputs: {
        resourceId:
          "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Network/routeTables/rt1",
      },
    });
    const subnet = res({
      resourceTypeId: "azure-subnet",
      fields: {
        name: "default",
        resourceGroup: "rg1",
        location: "eastus",
        vnetName: "vnet1",
      },
    });
    const put = vi.fn(async (_url: string, _body: unknown) => ({}));
    const get = vi.fn(async () => ({
      properties: {
        addressPrefix: "10.0.0.0/24",
        networkSecurityGroup: { id: "/nsg1" },
      },
    }));
    const ctx = {
      ...httpCtx({ get, put }),
      getResource: vi.fn(async (t: string) => (t === "azure-route-table" ? routeTable : subnet)),
    };
    await attachAzureResource(
      ctx as never,
      "azure-route-table",
      "rt",
      "azure-subnet",
      "subnet",
      "acct",
    );
    expect(put.mock.calls[0]![0]).toContain("/virtualNetworks/vnet1/subnets/default");
    const body = put.mock.calls[0]![1] as {
      properties: {
        addressPrefix: string;
        networkSecurityGroup: { id: string };
        routeTable: { id: string };
      };
    };
    expect(body.properties.addressPrefix).toBe("10.0.0.0/24");
    expect(body.properties.networkSecurityGroup.id).toBe("/nsg1");
    expect(body.properties.routeTable.id).toContain("/routeTables/rt1");
  });

  it("associates a NAT gateway with a subnet", async () => {
    const natGateway = res({
      resourceTypeId: "azure-nat-gateway",
      fields: { name: "nat1", resourceGroup: "rg1", location: "eastus" },
    });
    const subnet = res({
      resourceTypeId: "azure-subnet",
      fields: {
        name: "default",
        resourceGroup: "rg1",
        location: "eastus",
        vnetName: "vnet1",
      },
    });
    const put = vi.fn(async (_url: string, _body: unknown) => ({}));
    const ctx = {
      ...httpCtx({
        get: vi.fn(async () => ({ properties: { addressPrefix: "10.0.0.0/24" } })),
        put,
      }),
      getResource: vi.fn(async (t: string) => (t === "azure-nat-gateway" ? natGateway : subnet)),
    };
    await attachAzureResource(
      ctx as never,
      "azure-nat-gateway",
      "nat",
      "azure-subnet",
      "subnet",
      "acct",
    );
    const body = put.mock.calls[0]![1] as { properties: { natGateway: { id: string } } };
    expect(body.properties.natGateway.id).toContain("/natGateways/nat1");
  });

  it("creates a private DNS virtual network link", async () => {
    const zone = res({
      resourceTypeId: "azure-private-dns-zone",
      fields: { name: "privatelink.database.windows.net", resourceGroup: "dns-rg" },
    });
    const vnet = res({
      resourceTypeId: "azure-vnet",
      fields: { name: "app vnet", resourceGroup: "net-rg" },
      resolvedOutputs: {
        resourceId:
          "/subscriptions/sub1/resourceGroups/net-rg/providers/Microsoft.Network/virtualNetworks/app-vnet",
      },
    });
    const put = vi.fn(async (_url: string, _body: unknown) => ({}));
    const ctx = {
      ...httpCtx({ put }),
      getResource: vi.fn(async (t: string) => (t === "azure-private-dns-zone" ? zone : vnet)),
    };
    await attachAzureResource(
      ctx as never,
      "azure-private-dns-zone",
      "zone",
      "azure-vnet",
      "vnet",
      "acct",
    );
    expect(put.mock.calls[0]![0]).toContain(
      "/privateDnsZones/privatelink.database.windows.net/virtualNetworkLinks/app-vnet-link",
    );
    const body = put.mock.calls[0]![1] as {
      location: string;
      properties: { registrationEnabled: boolean; virtualNetwork: { id: string } };
    };
    expect(body.location).toBe("global");
    expect(body.properties.registrationEnabled).toBe(false);
    expect(body.properties.virtualNetwork.id).toContain("/virtualNetworks/app-vnet");
  });

  it("throws when the load balancer has no backend pools", async () => {
    const lb = res({
      resourceTypeId: "azure-load-balancer",
      displayName: "lb1",
      fields: { name: "lb1", resourceGroup: "rg1", location: "eastus" },
    });
    const ctx = {
      ...httpCtx({ get: vi.fn(async () => ({ properties: { backendAddressPools: [] } })) }),
      getResource: vi.fn(async (t: string) => (t === "azure-load-balancer" ? lb : vm)),
    };
    await expect(
      attachAzureResource(ctx as never, "azure-load-balancer", "lb", "azure-vm", "vms", "acct"),
    ).rejects.toThrow(/no backend address pools/);
  });

  it("throws when VM has no NICs", async () => {
    const nsg = res({
      resourceTypeId: "azure-nsg",
      fields: { name: "nsg1", resourceGroup: "rg1", location: "eastus" },
    });
    const ctx = {
      ...httpCtx({ get: vi.fn(async () => ({ properties: { networkProfile: {} } })) }),
      getResource: vi.fn(async (t: string) => (t === "azure-nsg" ? nsg : vm)),
    };
    await expect(
      attachAzureResource(ctx as never, "azure-nsg", "ns", "azure-vm", "vms", "acct"),
    ).rejects.toThrow(/no network interfaces/);
  });

  it("throws for an unsupported attachment", async () => {
    const ctx = { ...httpCtx(), getResource: vi.fn(async () => res({})) };
    await expect(
      attachAzureResource(ctx as never, "azure-disk", "ds", "azure-nsg", "ns", "acct"),
    ).rejects.toThrow(/attachResource not supported/);
  });
});

// ─── manifest ───────────────────────────────────────────────────────────────

describe("manifest get/apply", () => {
  it("getAzureManifest fetches and pretty-prints the ARM json (rg)", async () => {
    const get = vi.fn(async (_url: string) => ({ id: "/rg", location: "eastus" }));
    const ctx = httpCtx({ get });
    const out = await getAzureManifest(ctx as never, "acct:azure-resource-group:rg1");
    expect(get.mock.calls[0]![0]).toContain("/resourcegroups/rg1?api-version=2022-09-01");
    expect(JSON.parse(out)).toMatchObject({ location: "eastus" });
  });

  it("getAzureManifest builds the SQL database nested URL", async () => {
    const get = vi.fn(async (_url: string) => ({}));
    await getAzureManifest(httpCtx({ get }) as never, "acct:azure-sql-database:rg1/srv1/db1");
    expect(get.mock.calls[0]![0]).toContain("/servers/srv1/databases/db1");
  });

  it("getAzureManifest builds a standard provider URL", async () => {
    const get = vi.fn(async (_url: string) => ({}));
    await getAzureManifest(httpCtx({ get }) as never, "acct:azure-vm:rg1/vm1");
    expect(get.mock.calls[0]![0]).toContain("/providers/Microsoft.Compute/virtualMachines/vm1");
  });

  it("getAzureManifest throws for an unsupported type", async () => {
    await expect(getAzureManifest(httpCtx() as never, "acct:azure-weird:x")).rejects.toThrow(
      /manifest not supported/,
    );
  });

  it("applyAzureManifest PUTs the parsed body", async () => {
    const put = vi.fn(async (_url: string, _body: unknown) => ({}));
    await applyAzureManifest(
      httpCtx({ put }) as never,
      "acct:azure-vm:rg1/vm1",
      '{"location":"eastus"}',
    );
    expect(put.mock.calls[0]![1]).toEqual({ location: "eastus" });
  });
});

// ─── export-credential ──────────────────────────────────────────────────────

describe("exportAzureCredential", () => {
  const creds = { tenantId: "t1", clientId: "c1", clientSecret: "s1", subscriptionId: "sub1" };

  function saCtx(post: () => unknown) {
    return {
      ...httpCtx({ post: vi.fn(async () => post()) }),
      getResource: vi.fn(async () =>
        res({ resourceTypeId: "azure-storage-account", externalId: "rg1/s1" }),
      ),
      graphClient: {} as never,
      creds,
    };
  }

  it("storage connection-string format", async () => {
    const ctx = saCtx(() => ({ keys: [{ keyName: "key1", value: "k1" }] }));
    const out = await exportAzureCredential(
      ctx as never,
      "azure-storage-account",
      "id",
      "acct",
      "connection-string",
    );
    expect(out.content).toContain("AccountName=s1");
    expect(out.filename).toBe("s1.connection-string");
    expect(out.fields!.some((f) => f.sensitive)).toBe(true);
  });

  it("storage access-keys INI format with both keys", async () => {
    const ctx = saCtx(() => ({
      keys: [
        { keyName: "key1", value: "k1" },
        { keyName: "key2", value: "k2" },
      ],
    }));
    const out = await exportAzureCredential(
      ctx as never,
      "azure-storage-account",
      "id",
      "acct",
      "access-keys",
    );
    expect(out.content).toContain("primary_key=k1");
    expect(out.content).toContain("secondary_key=k2");
  });

  it("storage throws when no keys returned", async () => {
    const ctx = saCtx(() => ({ keys: [] }));
    await expect(
      exportAzureCredential(ctx as never, "azure-storage-account", "id", "acct", "access-keys"),
    ).rejects.toThrow(/no storage account keys/);
  });

  it("app registration client-secret mints a Graph password", async () => {
    const post = vi.fn(async () => ({ secretText: "minted", keyId: "kid", endDateTime: "2027" }));
    const api = vi.fn((_path: string) => ({ post }));
    const ctx = {
      ...httpCtx(),
      getResource: vi.fn(async () =>
        res({
          resourceTypeId: "azure-app-registration",
          externalId: "obj-1",
          displayName: "MyApp",
          fields: { appId: "app-1" },
        }),
      ),
      graphClient: { api } as never,
      creds,
    };
    const out = await exportAzureCredential(
      ctx as never,
      "azure-app-registration",
      "id",
      "acct",
      "client-secret",
    );
    expect(api.mock.calls[0]![0]).toBe("/applications/obj-1/addPassword");
    expect(out.content).toContain("AZURE_CLIENT_SECRET=minted");
    expect(out.content).toContain("AZURE_CLIENT_ID=app-1");
    expect(out.fields!.find((f) => f.label === "Key ID")?.value).toBe("kid");
  });

  it("app registration throws when Graph returns no secret", async () => {
    const api = vi.fn(() => ({ post: vi.fn(async () => ({ secretText: "" })) }));
    const ctx = {
      ...httpCtx(),
      getResource: vi.fn(async () =>
        res({
          resourceTypeId: "azure-app-registration",
          externalId: "obj-1",
          fields: { appId: "app-1" },
        }),
      ),
      graphClient: { api } as never,
      creds,
    };
    await expect(
      exportAzureCredential(ctx as never, "azure-app-registration", "id", "acct", "client-secret"),
    ).rejects.toThrow(/empty secretText/);
  });

  it("throws on unsupported type/format", async () => {
    const ctx = { ...httpCtx(), getResource: vi.fn(), graphClient: {} as never, creds };
    await expect(
      exportAzureCredential(ctx as never, "azure-vm", "id", "acct", "x"),
    ).rejects.toThrow(/not supported/);
  });
});

// ─── publish-handlers ─────────────────────────────────────────────────────

describe("publish-handlers", () => {
  const sbResource = res({
    resourceTypeId: "azure-service-bus",
    fields: { serviceBusEndpoint: "https://ns1.servicebus.windows.net:443/", name: "ns1" },
  });
  const ctx = { serviceBusToken: vi.fn(async () => "sb-tok") };

  it("publishServiceBus posts to the entity endpoint with broker properties", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 201, text: async () => "" } as unknown as Response);
    const out = await publishServiceBus(ctx, sbResource, {
      body: "hello",
      extras: { entity: "my-queue", properties: { Label: "x", "  ": "skip" } },
    } as never);
    expect(out.summary).toContain("my-queue");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://ns1.servicebus.windows.net/my-queue/messages");
    expect(JSON.parse((init!.headers as Record<string, string>)["BrokerProperties"]!)).toEqual({
      Label: "x",
    });
    fetchSpy.mockRestore();
  });

  it("publishServiceBus requires an entity", async () => {
    await expect(
      publishServiceBus(ctx, sbResource, { body: "x", extras: {} } as never),
    ).rejects.toThrow(/Queue or topic name is required/);
  });

  it("publishServiceBus surfaces a non-ok response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    } as unknown as Response);
    await expect(
      publishServiceBus(ctx, sbResource, { body: "x", extras: { entity: "q" } } as never),
    ).rejects.toThrow(/Service Bus send 500: boom/);
    fetchSpy.mockRestore();
  });

  it("publishEventHub posts with a partition key and falls back to name-derived host", async () => {
    const ehResource = res({
      resourceTypeId: "azure-event-hub",
      fields: { name: "eh-ns" },
      displayName: "eh-ns",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, status: 201, text: async () => "" } as unknown as Response);
    const out = await publishEventHub(ctx, ehResource, {
      body: "evt",
      extras: { hub: "my-hub", partitionKey: "pk-1" },
    } as never);
    expect(out.summary).toContain("my-hub");
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://eh-ns.servicebus.windows.net/my-hub/messages");
    expect((init!.headers as Record<string, string>)["BrokerProperties"]).toContain("pk-1");
    fetchSpy.mockRestore();
  });

  it("publishEventHub requires a hub name", async () => {
    await expect(
      publishEventHub(ctx, res({ resourceTypeId: "azure-event-hub" }), {
        body: "x",
        extras: {},
      } as never),
    ).rejects.toThrow(/Event hub name is required/);
  });
});
