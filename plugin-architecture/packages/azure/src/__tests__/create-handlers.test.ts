import { describe, it, expect, vi } from "vitest";
import type { AzureCreateContext } from "../create-handlers-shared.js";
import { fetchResourceGroups } from "../create-handlers-shared.js";
import { createResourceGroup } from "../resource-group-create-handlers.js";
import { createSimpleResource } from "../simple-create-handlers.js";
import { createVM } from "../vm-create-handlers.js";
import { createDisk } from "../disk-create-handlers.js";
import { createVNet } from "../vnet-create-handlers.js";
import { createKeyVault } from "../key-vault-create-handlers.js";
import { createContainerRegistry } from "../container-registry-create-handlers.js";
import { createPublicIP } from "../public-ip-create-handlers.js";
import { createLogAnalyticsWorkspace } from "../log-analytics-create-handlers.js";
import { createCosmosDB } from "../cosmos-db-create-handlers.js";
import { createRedisCache } from "../redis-cache-create-handlers.js";
import { createStorageAccount } from "../storage-account-create-handlers.js";
import { createContainerInstance } from "../container-instance-create-handlers.js";
import { createMessagingNamespace } from "../messaging-namespace-create-handlers.js";
import { createFlexibleDB } from "../flexible-db-create-handlers.js";
import { createSQLDatabase } from "../sql-database-create-handlers.js";
import { createAppService } from "../app-service-create-handlers.js";
import { createFunctionApp } from "../function-app-create-handlers.js";
import { createAKSCluster } from "../aks-create-handlers.js";
import { createAppRegistration } from "../app-registration-create-handlers.js";
import { createLoadBalancer } from "../load-balancer-create-handlers.js";

function makeCtx(overrides: Record<string, unknown> = {}): AzureCreateContext {
  return {
    get: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
    put: vi.fn(async (_url: string, _body: unknown) => ({
      id: "/arm/id",
      properties: { provisioningState: "Creating" },
    })),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => undefined),
    makeId: (a: string, t: string, e: string) => `${a}:${t}:${e}`,
    graphClient: {} as never,
    subscriptionId: "sub1",
    tenantId: "t1",
    clientId: "c1",
    clientSecret: "s1",
    ...overrides,
  } as unknown as AzureCreateContext;
}

const ACCT = "acct";

describe("fetchResourceGroups", () => {
  it("maps rg names to id/label options", async () => {
    const ctx = makeCtx({
      get: vi.fn(async () => ({ value: [{ name: "rg1" }, { name: "rg2" }] })),
    });
    expect(await fetchResourceGroups(ctx)).toEqual([
      { id: "rg1", label: "rg1" },
      { id: "rg2", label: "rg2" },
    ]);
  });
});

describe("createResourceGroup", () => {
  it("PUTs the rg and returns a ResourceInstance", async () => {
    const put = vi.fn(async () => ({
      id: "/rg-id",
      properties: { provisioningState: "Succeeded" },
    }));
    const ctx = makeCtx({ put });
    const out = await createResourceGroup(ctx, ACCT, { name: "rg1", region: "eastus" });
    expect((put.mock.calls[0] as unknown as [string, unknown])[0]).toContain(
      "/resourcegroups/rg1?api-version=2022-09-01",
    );
    expect(out).toMatchObject({
      resourceTypeId: "azure-resource-group",
      externalId: "rg1",
      fields: { name: "rg1", location: "eastus", provisioningState: "Succeeded" },
    });
  });
});

describe("createSimpleResource", () => {
  it("PUTs a generic provider resource", async () => {
    const put = vi.fn(async () => ({ properties: { provisioningState: "Creating" } }));
    const ctx = makeCtx({ put });
    const out = await createSimpleResource(
      ctx,
      ACCT,
      "azure-nsg",
      { name: "nsg1", resourceGroup: "rg1", region: "eastus" },
      "Microsoft.Network/networkSecurityGroups",
      "2023-09-01",
      { foo: "bar" },
    );
    const [url, body] = put.mock.calls[0] as unknown as [string, unknown];
    expect(url).toContain("/providers/Microsoft.Network/networkSecurityGroups/nsg1");
    expect(body).toEqual({ location: "eastus", properties: { foo: "bar" } });
    expect(out.externalId).toBe("rg1/nsg1");
  });
});

describe("createVM", () => {
  it("creates the full VM dependency chain (vnet, pip, nsg, nic, vm)", async () => {
    const urls: string[] = [];
    const put = vi.fn(async (url: string) => {
      urls.push(url);
      return { id: `/arm${urls.length}`, properties: { provisioningState: "Creating" } };
    });
    const ctx = makeCtx({ put });
    const out = await createVM(ctx, ACCT, {
      name: "vm1",
      resourceGroup: "rg1",
      region: "eastus",
      size: "Standard_B1s",
      image: "Canonical:ubuntu:22:latest",
      bootDiskSizeGb: "64",
      adminUsername: "azureuser",
      sshKey: "ssh-rsa AAA",
    });
    expect(urls.some((u) => u.includes("/virtualNetworks/vm1-vnet"))).toBe(true);
    expect(urls.some((u) => u.includes("/publicIPAddresses/vm1-pip"))).toBe(true);
    expect(urls.some((u) => u.includes("/networkSecurityGroups/vm1-nsg"))).toBe(true);
    expect(urls.some((u) => u.includes("/networkInterfaces/vm1-nic"))).toBe(true);
    expect(urls.some((u) => u.includes("/virtualMachines/vm1"))).toBe(true);
    expect(out.fields["osType"]).toBe("Linux");
  });

  it("uses an existing NSG and a Windows RDP rule for Windows images", async () => {
    const urls: string[] = [];
    const put = vi.fn(async (url: string) => {
      urls.push(url);
      return { id: "/arm", properties: {} };
    });
    const ctx = makeCtx({ put });
    const out = await createVM(ctx, ACCT, {
      name: "win1",
      resourceGroup: "rg1",
      region: "eastus",
      size: "Standard_B1s",
      image: "MicrosoftWindowsServer:WindowsServer:2022:latest",
      adminUsername: "admin",
      securityGroup: "/existing/nsg",
      addExtraDisk: "true",
      extraDiskSizeGb: "128",
      extraDiskSku: "Premium_LRS",
    });
    // Existing NSG → no auto-create of a networkSecurityGroups resource.
    expect(urls.some((u) => u.includes("/networkSecurityGroups/"))).toBe(false);
    expect(out.fields["osType"]).toBe("Windows");
  });
});

describe("single-PUT create handlers", () => {
  it("createDisk", async () => {
    const put = vi.fn(async () => ({ properties: { encryption: "platform" } }));
    const out = await createDisk(makeCtx({ put }), ACCT, {
      name: "d1",
      resourceGroup: "rg1",
      region: "eastus",
      sku: "Premium_LRS",
      diskSizeGb: "256",
    });
    expect((put.mock.calls[0] as unknown as [string, unknown])[0]).toContain("/disks/d1");
    expect(out.fields["diskSizeGb"]).toBe(256);
  });

  it("createVNet", async () => {
    const put = vi.fn(async () => ({ properties: { provisioningState: "Creating" } }));
    const out = await createVNet(makeCtx({ put }), ACCT, {
      name: "vn1",
      resourceGroup: "rg1",
      region: "eastus",
    });
    expect(out.fields["addressSpace"]).toBe("10.0.0.0/16");
  });

  it("createKeyVault", async () => {
    const put = vi.fn(async () => ({ properties: { vaultUri: "https://v1.vault.azure.net/" } }));
    const out = await createKeyVault(makeCtx({ put }), ACCT, {
      name: "v1",
      resourceGroup: "rg1",
      region: "eastus",
      enableSoftDelete: "false",
    });
    expect(out.fields["enableSoftDelete"]).toBe(false);
    expect(out.resolvedOutputs["vaultUri"]).toBe("https://v1.vault.azure.net/");
  });

  it("createContainerRegistry", async () => {
    const put = vi.fn(async () => ({ properties: { loginServer: "acr1.azurecr.io" } }));
    const out = await createContainerRegistry(makeCtx({ put }), ACCT, {
      name: "acr1",
      resourceGroup: "rg1",
      region: "eastus",
      adminEnabled: "true",
    });
    expect(out.fields["adminEnabled"]).toBe(true);
    expect(out.resolvedOutputs["loginServer"]).toBe("acr1.azurecr.io");
  });

  it("createContainerRegistry defaults the admin user to enabled", async () => {
    const put = vi.fn(async () => ({ properties: { loginServer: "acr1.azurecr.io" } }));
    const out = await createContainerRegistry(makeCtx({ put }), ACCT, {
      name: "acr1",
      resourceGroup: "rg1",
      region: "eastus",
    });
    const body = (
      put.mock.calls[0] as unknown as [string, { properties: { adminUserEnabled: boolean } }]
    )[1];
    expect(body.properties.adminUserEnabled).toBe(true);
    expect(out.fields["adminEnabled"]).toBe(true);

    const putOff = vi.fn(async () => ({ properties: {} }));
    const off = await createContainerRegistry(makeCtx({ put: putOff }), ACCT, {
      name: "acr2",
      resourceGroup: "rg1",
      region: "eastus",
      adminEnabled: "false",
    });
    expect(off.fields["adminEnabled"]).toBe(false);
  });

  it("createPublicIP", async () => {
    const put = vi.fn(async () => ({ properties: { ipAddress: "1.2.3.4" } }));
    const out = await createPublicIP(makeCtx({ put }), ACCT, {
      name: "pip1",
      resourceGroup: "rg1",
      region: "eastus",
    });
    expect(out.resolvedOutputs["ipAddress"]).toBe("1.2.3.4");
  });

  it("createLogAnalyticsWorkspace", async () => {
    const put = vi.fn(async () => ({ properties: { customerId: "cust" } }));
    const out = await createLogAnalyticsWorkspace(makeCtx({ put }), ACCT, {
      name: "la1",
      resourceGroup: "rg1",
      region: "eastus",
      retentionInDays: "60",
    });
    expect(out.fields["retentionInDays"]).toBe(60);
    expect(out.resolvedOutputs["customerId"]).toBe("cust");
  });

  it("createCosmosDB", async () => {
    const put = vi.fn(async () => ({ properties: {} }));
    const out = await createCosmosDB(makeCtx({ put }), ACCT, {
      name: "c1",
      resourceGroup: "rg1",
      region: "eastus",
    });
    expect(out.resolvedOutputs["documentEndpoint"]).toContain("c1.documents.azure.com");
  });

  it("createRedisCache (premium family)", async () => {
    const put = vi.fn(async () => ({ properties: {} }));
    const out = await createRedisCache(makeCtx({ put }), ACCT, {
      name: "r1",
      resourceGroup: "rg1",
      region: "eastus",
      sku: "Premium",
      capacity: "1",
    });
    const body = (
      put.mock.calls[0] as unknown as [string, { properties: { sku: { family: string } } }]
    )[1];
    expect(body.properties.sku.family).toBe("P");
    expect(out.resolvedOutputs["hostName"]).toContain("r1.redis.cache.windows.net");
  });

  it("createStorageAccount", async () => {
    const put = vi.fn(async () => ({
      properties: { primaryEndpoints: { blob: "https://s1.blob/" } },
    }));
    const out = await createStorageAccount(makeCtx({ put }), ACCT, {
      name: "s1",
      resourceGroup: "rg1",
      region: "eastus",
    });
    expect(out.resolvedOutputs["primaryBlobEndpoint"]).toBe("https://s1.blob/");
  });

  it("createContainerInstance", async () => {
    const put = vi.fn(async () => ({
      properties: { ipAddress: { ip: "1.2.3.4", fqdn: "ci.io" } },
    }));
    const out = await createContainerInstance(makeCtx({ put }), ACCT, {
      name: "ci1",
      resourceGroup: "rg1",
      region: "eastus",
      image: "nginx",
    });
    expect(out.resolvedOutputs["ipAddress"]).toBe("1.2.3.4");
    expect(out.fields["containers"]).toBe(1);
  });

  it("createLoadBalancer", async () => {
    const put = vi.fn(async () => ({ properties: { provisioningState: "Succeeded" } }));
    const out = await createLoadBalancer(makeCtx({ put }), ACCT, {
      name: "lb1",
      resourceGroup: "rg1",
      region: "eastus",
      sku: "Standard",
    });
    const [url, body] = put.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toContain("/loadBalancers/lb1?api-version=2023-09-01");
    expect(body).toMatchObject({ location: "eastus", sku: { name: "Standard" } });
    expect(out).toMatchObject({
      resourceTypeId: "azure-load-balancer",
      externalId: "rg1/lb1",
      fields: { name: "lb1", sku: "Standard", provisioningState: "Succeeded" },
    });
  });

  it("createMessagingNamespace", async () => {
    const put = vi.fn(async () => ({ properties: { serviceBusEndpoint: "https://sb/" } }));
    const out = await createMessagingNamespace(
      makeCtx({ put }),
      ACCT,
      { name: "sb1", resourceGroup: "rg1", region: "eastus" },
      "azure-service-bus",
      "Microsoft.ServiceBus/namespaces",
      "2022-10-01-preview",
    );
    expect(out.resourceTypeId).toBe("azure-service-bus");
    expect(out.resolvedOutputs["serviceBusEndpoint"]).toBe("https://sb/");
  });

  it("createFlexibleDB derives tier from sku prefix", async () => {
    const put = vi.fn(async () => ({ properties: { fullyQualifiedDomainName: "pg.host" } }));
    const out = await createFlexibleDB(
      makeCtx({ put }),
      ACCT,
      {
        name: "pg1",
        resourceGroup: "rg1",
        region: "eastus",
        version: "16",
        sku: "Standard_B1ms",
        adminPassword: "p",
      },
      "azure-postgres-flexible",
      "Microsoft.DBforPostgreSQL/flexibleServers",
      "2023-06-01-preview",
    );
    expect(out.fields["tier"]).toBe("Burstable");
    expect(out.resolvedOutputs["fqdn"]).toBe("pg.host");
  });

  it("createAKSCluster", async () => {
    const put = vi.fn(async () => ({ properties: { fqdn: "k1.azmk8s.io" } }));
    const out = await createAKSCluster(makeCtx({ put }), ACCT, {
      name: "k1",
      resourceGroup: "rg1",
      region: "eastus",
      kubernetesVersion: "1.29",
      nodeSize: "Standard_D2s_v5",
      nodeCount: "3",
      osDiskSizeGb: "128",
    });
    const body = (
      put.mock.calls[0] as unknown as [
        string,
        {
          identity: { type: string };
          properties: { servicePrincipalProfile?: unknown };
        },
      ]
    )[1];
    // The cluster must run on a system-assigned managed identity; sending a
    // real service principal alongside it is rejected by ARM.
    expect(body.identity).toEqual({ type: "SystemAssigned" });
    expect(body.properties.servicePrincipalProfile).toBeUndefined();
    expect(out.fields["nodeCount"]).toBe(3);
  });
});

describe("createSQLDatabase", () => {
  it("creates a new server then the database", async () => {
    const urls: string[] = [];
    const put = vi.fn(async (url: string) => {
      urls.push(url);
      return { properties: { status: "Online" } };
    });
    const out = await createSQLDatabase(makeCtx({ put }), ACCT, {
      databaseName: "db1",
      resourceGroup: "rg1",
      region: "eastus",
      serverName: "srv1",
      adminPassword: "pw",
      sku: "S0",
    });
    expect(urls.some((u) => u.includes("/servers/srv1?"))).toBe(true);
    expect(urls.some((u) => u.includes("/databases/db1?"))).toBe(true);
    expect(out.fields["edition"]).toBe("Standard");
    expect(out.externalId).toBe("rg1/srv1/db1");
  });

  it("reuses an existing server (rg/server) and skips vCore maxSize", async () => {
    const urls: string[] = [];
    const put = vi.fn(async (url: string) => {
      urls.push(url);
      return { properties: {} };
    });
    const out = await createSQLDatabase(makeCtx({ put }), ACCT, {
      databaseName: "db1",
      resourceGroup: "ignored",
      region: "eastus",
      existingServer: "rgX/srvX",
      sku: "GP_Gen5_2",
    });
    expect(urls.some((u) => u.includes("/servers/srvX?"))).toBe(false);
    expect(out.externalId).toBe("rgX/srvX/db1");
    expect(out.fields["edition"]).toBe("GeneralPurpose");
  });
});

describe("createAppService / createFunctionApp", () => {
  it("createAppService creates the plan then the site", async () => {
    const urls: string[] = [];
    const put = vi.fn(async (url: string) => {
      urls.push(url);
      return { properties: { defaultHostName: "app.azurewebsites.net" } };
    });
    const out = await createAppService(makeCtx({ put }), ACCT, {
      name: "app1",
      resourceGroup: "rg1",
      region: "eastus",
    });
    expect(urls.some((u) => u.includes("/serverfarms/app1-plan"))).toBe(true);
    expect(urls.some((u) => u.includes("/sites/app1"))).toBe(true);
    expect(out.resolvedOutputs["defaultHostName"]).toBe("app.azurewebsites.net");
  });

  it("createFunctionApp fetches a storage key and wires the connection string", async () => {
    const post = vi.fn(async () => ({ keys: [{ value: "skey" }] }));
    const put = vi.fn(async () => ({ properties: {} }));
    await createFunctionApp(makeCtx({ put, post }), ACCT, {
      name: "fn1",
      resourceGroup: "rg1",
      region: "eastus",
      storageAccount: "rgS/saccount",
    });
    expect((post.mock.calls[0] as unknown as [string, unknown])[0]).toContain(
      "/storageAccounts/saccount/listKeys",
    );
    const siteBody = (
      put.mock.calls[put.mock.calls.length - 1] as unknown as [
        string,
        { properties: { siteConfig: { appSettings: Array<{ name: string; value: string }> } } },
      ]
    )[1];
    const storageSetting = siteBody.properties.siteConfig.appSettings.find(
      (s) => s.name === "AzureWebJobsStorage",
    );
    expect(storageSetting!.value).toContain("AccountKey=skey");
  });
});

describe("createAppRegistration (Graph)", () => {
  it("creates the app and service principal", async () => {
    const calls: string[] = [];
    const api = vi.fn((path: string) => {
      calls.push(path);
      if (path === "/applications") {
        return { post: vi.fn(async () => ({ id: "obj-1", appId: "app-1" })) };
      }
      return { post: vi.fn(async () => ({ id: "sp-1" })) };
    });
    const ctx = makeCtx({ graphClient: { api } as never });
    const out = await createAppRegistration(ctx, ACCT, { displayName: "MyApp" });
    expect(out.fields["servicePrincipalId"]).toBe("sp-1");
    expect(out.fields["appId"]).toBe("app-1");
    expect(out.resolvedOutputs["tenantId"]).toBe("t1");
  });

  it("requires a displayName", async () => {
    await expect(createAppRegistration(makeCtx(), ACCT, {})).rejects.toThrow(
      /displayName is required/,
    );
  });

  it("rolls back the app when SP creation fails", async () => {
    const deleteApi = vi.fn(async () => undefined);
    const api = vi.fn((path: string) => {
      if (path === "/applications") {
        return { post: vi.fn(async () => ({ id: "obj-1", appId: "app-1" })) };
      }
      if (path === "/servicePrincipals") {
        return { post: vi.fn(async () => Promise.reject(new Error("sp boom"))) };
      }
      return { delete: deleteApi };
    });
    const ctx = makeCtx({ graphClient: { api } as never });
    await expect(createAppRegistration(ctx, ACCT, { displayName: "MyApp" })).rejects.toThrow(
      /Service principal creation failed.*sp boom/,
    );
    expect(deleteApi).toHaveBeenCalled();
  });

  it("throws when Graph returns an empty application", async () => {
    const api = vi.fn(() => ({ post: vi.fn(async () => ({})) }));
    const ctx = makeCtx({ graphClient: { api } as never });
    await expect(createAppRegistration(ctx, ACCT, { displayName: "X" })).rejects.toThrow(
      /empty application/,
    );
  });
});
