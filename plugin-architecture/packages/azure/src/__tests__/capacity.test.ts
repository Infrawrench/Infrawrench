import { describe, expect, it, vi } from "vitest";
import {
  capacityDeclarations,
  resolveCapacityLimit,
  readCapacityNumber,
  type ResourceInstance,
} from "@infrawrench/plugin-base";
import * as listers from "../resource-listers.js";
import type { ListerContext } from "../resource-listers.js";
import { fetchAzureMetricSeries } from "../metrics.js";
import { plugin } from "../plugin.js";
import type { AzureHttpContext } from "../shared.js";

const ARM = "https://management.azure.com";
const SUB = "/subscriptions/sub1/resourceGroups/rg1/providers";

/** A lister context answering by URL; an `Error` answer is thrown. */
function makeCtx(route: (url: string) => unknown): ListerContext & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    get: vi.fn(async (url: string) => {
      urls.push(url);
      const out = route(url);
      if (out instanceof Error) throw out;
      return out;
    }) as ListerContext["get"],
    post: vi.fn(async () => ({})) as ListerContext["post"],
    put: vi.fn(async () => ({})) as ListerContext["put"],
    del: vi.fn(async () => undefined),
    id: (a, t, e) => `${a}:${t}:${e}`,
    now: () => "2026-11-23T00:00:00Z",
    subscriptionId: "sub1",
  };
}

function typeOf(id: string) {
  const type = plugin.resourceTypes.find((t) => t.id === id);
  if (!type) throw new Error(`no type ${id}`);
  return type;
}

/** Every declared usage of a type that resolves to a reading against `values`. */
function readings(typeId: string, values: Record<string, unknown>) {
  return capacityDeclarations(typeOf(typeId))
    .filter((d) => d.source !== "metric")
    .flatMap((d) => {
      const used = readCapacityNumber(values[d.valueKey]);
      const limit = resolveCapacityLimit(d.declaration.limit, values);
      return used === null || !limit ? [] : [{ key: d.key, used, limit: limit.limit }];
    });
}

describe("AKS autoscaler ceiling", () => {
  const cluster = (pools: unknown[]) => ({
    value: [
      {
        id: `${SUB}/Microsoft.ContainerService/managedClusters/aks1`,
        name: "aks1",
        location: "eastus",
        properties: { agentPoolProfiles: pools },
      },
    ],
  });

  it("sums the autoscaled pools' nodes and maxCount, skipping fixed pools", async () => {
    const ctx = makeCtx(() =>
      cluster([
        { name: "system", count: 3, enableAutoScaling: false },
        { name: "user", count: 4, enableAutoScaling: true, minCount: 1, maxCount: 5 },
        { name: "gpu", count: 1, enableAutoScaling: true, minCount: 0, maxCount: 3 },
      ]),
    );
    const [aks] = await listers.listAKSClusters(ctx, "acct");
    expect(aks!.fields).toMatchObject({ autoscaleNodeCount: 5, autoscaleMaxNodes: 8 });
    expect(readings("azure-aks-cluster", aks!.fields)).toEqual([
      { key: "autoscaleNodeCount", used: 5, limit: 8 },
    ]);
  });

  it("leaves no reading when no pool autoscales", async () => {
    const ctx = makeCtx(() => cluster([{ name: "system", count: 3 }]));
    const [aks] = await listers.listAKSClusters(ctx, "acct");
    expect(aks!.fields["autoscaleNodeCount"]).toBe("");
    expect(readings("azure-aks-cluster", aks!.fields)).toEqual([]);
  });
});

describe("Container Registry quota usages", () => {
  const registryId = `${SUB}/Microsoft.ContainerRegistry/registries/myRegistry`;
  const list = {
    value: [{ id: registryId, name: "myRegistry", sku: { name: "Standard" }, properties: {} }],
  };

  it("reads Size and Webhooks from listUsages", async () => {
    // The documented example response for Registries - List Usages.
    const ctx = makeCtx((url) =>
      url.includes("/listUsages")
        ? {
            value: [
              { name: "Size", limit: 107374182400, currentValue: 12345678, unit: "Bytes" },
              { name: "Webhooks", limit: 10, currentValue: 2, unit: "Count" },
            ],
          }
        : list,
    );
    const [reg] = await listers.listContainerRegistries(ctx, "acct");
    expect(ctx.urls).toContain(`${ARM}${registryId}/listUsages?api-version=2023-07-01`);
    expect(reg!.fields).toMatchObject({
      storageUsedBytes: 12345678,
      storageQuotaBytes: 107374182400,
      webhookCount: 2,
      webhookLimit: 10,
    });
    expect(readings("azure-container-registry", reg!.fields)).toEqual([
      { key: "storageUsedBytes", used: 12345678, limit: 107374182400 },
      { key: "webhookCount", used: 2, limit: 10 },
    ]);
  });

  it("keeps the registry and leaves the usage fields out when listUsages fails", async () => {
    const ctx = makeCtx((url) =>
      url.includes("/listUsages") ? new Error("Azure API 403 AuthorizationFailed") : list,
    );
    const [reg] = await listers.listContainerRegistries(ctx, "acct");
    expect(reg!.displayName).toBe("myRegistry");
    expect(reg!.fields).not.toHaveProperty("storageUsedBytes");
    expect(reg!.fields).not.toHaveProperty("webhookCount");
  });
});

describe("App Service plan capacity", () => {
  const planId = `${SUB}/Microsoft.Web/serverfarms/plan1`;
  const plan = (sku: Record<string, unknown>, props: Record<string, unknown>) => ({
    value: [{ id: planId, name: "plan1", sku, properties: props }],
  });

  it("reads the plan's FileSystemStorage usage and declares instances and storage", async () => {
    const ctx = makeCtx((url) =>
      url.includes("/usages")
        ? {
            value: [
              {
                unit: "Bytes",
                currentValue: 640584704,
                limit: 53687091200,
                name: { value: "FileSystemStorage", localizedValue: "File System Storage" },
              },
            ],
          }
        : plan(
            { name: "S1", tier: "Standard", capacity: 3 },
            { numberOfWorkers: 3, maximumNumberOfWorkers: 10, numberOfSites: 4 },
          ),
    );
    const [out] = await listers.listAppServicePlans(ctx, "acct");
    expect(out!.fields).toMatchObject({
      fileSystemUsedBytes: 640584704,
      fileSystemLimitBytes: 53687091200,
    });
    expect(readings("azure-app-service-plan", out!.fields)).toEqual([
      { key: "workerCount", used: 3, limit: 10 },
      { key: "fileSystemUsedBytes", used: 640584704, limit: 53687091200 },
    ]);
  });

  it("caps apps on the Free tier at the published 10", async () => {
    const ctx = makeCtx((url) =>
      url.includes("/usages")
        ? { value: [] }
        : plan({ name: "F1", tier: "Free" }, { numberOfWorkers: 1, numberOfSites: 7 }),
    );
    const [out] = await listers.listAppServicePlans(ctx, "acct");
    expect(out!.fields).not.toHaveProperty("fileSystemUsedBytes");
    const siteRow = readings("azure-app-service-plan", out!.fields).find(
      (r) => r.key === "siteCount",
    );
    expect(siteRow).toEqual({ key: "siteCount", used: 7, limit: 10 });
  });
});

describe("subnet IP usage", () => {
  const vnetId = `${SUB}/Microsoft.Network/virtualNetworks/vnetName`;
  const vnets = {
    value: [
      {
        id: vnetId,
        name: "vnetName",
        location: "eastus",
        properties: {
          subnets: [
            { id: `${vnetId}/subnets/GatewaySubnet`, name: "GatewaySubnet", properties: {} },
            { id: `${vnetId}/subnets/newSubnet`, name: "newSubnet", properties: {} },
          ],
        },
      },
    ],
  };

  it("maps the network's usages onto each subnet", async () => {
    // The documented example response for Virtual Networks - List Usage.
    const ctx = makeCtx((url) =>
      url.includes("/usages")
        ? {
            value: [
              {
                name: { localizedValue: "Subnet size and usage", value: "SubnetSpace" },
                currentValue: -1,
                id: `${vnetId}/subnets/GatewaySubnet`,
                limit: -1,
                unit: "Count",
              },
              {
                name: { localizedValue: "Subnet size and usage", value: "SubnetSpace" },
                currentValue: 2,
                id: `${vnetId}/subnets/newSubnet`,
                limit: 3,
                unit: "Count",
              },
            ],
          }
        : vnets,
    );
    const out = await listers.listSubnets(ctx, "acct");
    const byName = Object.fromEntries(out.map((s) => [s.fields["name"], s.fields]));
    expect(byName["newSubnet"]).toMatchObject({ ipAddressesUsed: 2, ipAddressCapacity: 3 });
    expect(byName["GatewaySubnet"]).toMatchObject({ ipAddressesUsed: "", ipAddressCapacity: "" });
    expect(readings("azure-subnet", byName["newSubnet"]!)).toEqual([
      { key: "ipAddressesUsed", used: 2, limit: 3 },
    ]);
    expect(readings("azure-subnet", byName["GatewaySubnet"]!)).toEqual([]);
  });

  it("keeps every subnet and leaves the IP fields out when the usages read fails", async () => {
    const ctx = makeCtx((url) => (url.includes("/usages") ? new Error("Azure API 500") : vnets));
    const out = await listers.listSubnets(ctx, "acct");
    expect(out).toHaveLength(2);
    for (const subnet of out) expect(subnet.fields).not.toHaveProperty("ipAddressesUsed");
  });

  it("leaves the IP fields out when the usages answer is not a list", async () => {
    const ctx = makeCtx((url) => (url.includes("/usages") ? {} : vnets));
    const out = await listers.listSubnets(ctx, "acct");
    expect(out).toHaveLength(2);
    for (const subnet of out) expect(subnet.fields).not.toHaveProperty("ipAddressesUsed");
  });
});

describe("Service Bus fullest entity", () => {
  const nsId = `${SUB}/Microsoft.ServiceBus/namespaces/sb1`;
  const namespaces = { value: [{ id: nsId, name: "sb1", sku: { name: "Standard" } }] };
  const entity = (name: string, sizeInBytes: number, maxSizeInMegabytes: number) => ({
    name,
    properties: { sizeInBytes, maxSizeInMegabytes, messageCount: 0, status: "Active" },
  });

  it("reports the queue or topic closest to its maximum size", async () => {
    const ctx = makeCtx((url) => {
      if (url.includes("/queues?")) return { value: [entity("orders", 512 * 1024 * 1024, 1024)] };
      if (url.includes("/topics?")) return { value: [entity("events", 900 * 1024 * 1024, 1024)] };
      return namespaces;
    });
    const [ns] = await listers.listServiceBusNamespaces(ctx, "acct");
    expect(ns!.fields).toMatchObject({ fullestEntity: "events", fullestEntityPercent: 87.89 });
    expect(readings("azure-service-bus", ns!.fields)).toEqual([
      { key: "fullestEntityPercent", used: 87.89, limit: 100 },
    ]);
  });

  it("leaves the fields out when either list fails", async () => {
    const ctx = makeCtx((url) => {
      if (url.includes("/queues?")) return { value: [entity("orders", 1, 1024)] };
      if (url.includes("/topics?")) return new Error("Azure API 400 BadRequest");
      return namespaces;
    });
    const [ns] = await listers.listServiceBusNamespaces(ctx, "acct");
    expect(ns!.displayName).toBe("sb1");
    expect(ns!.fields).not.toHaveProperty("fullestEntityPercent");
  });

  it("gives no reading for a namespace with no queues or topics", async () => {
    const ctx = makeCtx((url) =>
      url.includes("/queues?") || url.includes("/topics?") ? { value: [] } : namespaces,
    );
    const [ns] = await listers.listServiceBusNamespaces(ctx, "acct");
    expect(ns!.fields["fullestEntityPercent"]).toBe("");
    expect(readings("azure-service-bus", ns!.fields)).toEqual([]);
  });
});

describe("Event Hubs throughput units", () => {
  const ns = (sku: Record<string, unknown>, props: Record<string, unknown>) => ({
    value: [
      { id: `${SUB}/Microsoft.EventHub/namespaces/eh1`, name: "eh1", sku, properties: props },
    ],
  });

  it("reads Standard throughput units against the auto-inflate ceiling", async () => {
    const ctx = makeCtx(() =>
      ns(
        { name: "Standard", tier: "Standard", capacity: 6 },
        { isAutoInflateEnabled: true, maximumThroughputUnits: 8 },
      ),
    );
    const [out] = await listers.listEventHubNamespaces(ctx, "acct");
    expect(readings("azure-event-hub", out!.fields)).toEqual([
      { key: "throughputUnits", used: 6, limit: 8 },
    ]);
  });

  it("gives no reading without auto-inflate or on Premium", async () => {
    const off = await listers.listEventHubNamespaces(
      makeCtx(() =>
        ns({ name: "Standard", tier: "Standard", capacity: 2 }, { maximumThroughputUnits: 0 }),
      ),
      "acct",
    );
    expect(readings("azure-event-hub", off[0]!.fields)).toEqual([]);
    const premium = await listers.listEventHubNamespaces(
      makeCtx(() => ns({ name: "Premium", tier: "Premium", capacity: 1 }, {})),
      "acct",
    );
    expect(premium[0]!.fields["throughputUnits"]).toBe("");
  });
});

describe("networking limits", () => {
  it("counts load-balancing and inbound NAT rules against the SKU's limit", async () => {
    const ctx = makeCtx(() => ({
      value: [
        {
          id: `${SUB}/Microsoft.Network/loadBalancers/lb1`,
          name: "lb1",
          sku: { name: "Standard" },
          properties: {
            frontendIPConfigurations: [{ properties: {} }],
            loadBalancingRules: [{}, {}],
            inboundNatRules: [{}],
          },
        },
      ],
    }));
    const [lb] = await listers.listLoadBalancers(ctx, "acct");
    expect(lb!.fields).toMatchObject({ ruleCount: 2, inboundNatRuleCount: 1, totalRuleCount: 3 });
    expect(readings("azure-load-balancer", lb!.fields)).toEqual([
      { key: "frontendIpCount", used: 1, limit: 600 },
      { key: "totalRuleCount", used: 3, limit: 1500 },
    ]);
  });

  it("declares the documented per-resource ceilings", () => {
    expect(readings("azure-nsg", { securityRuleCount: 40 })).toEqual([
      { key: "securityRuleCount", used: 40, limit: 2000 },
    ]);
    expect(readings("azure-route-table", { routeCount: 12 })).toEqual([
      { key: "routeCount", used: 12, limit: 1000 },
    ]);
    expect(readings("azure-vnet", { subnetCount: 4 })).toEqual([
      { key: "subnetCount", used: 4, limit: 3000 },
    ]);
    expect(readings("azure-app-gateway", { backendPoolCount: 3, httpListenerCount: 9 })).toEqual([
      { key: "backendPoolCount", used: 3, limit: 100 },
      { key: "httpListenerCount", used: 9, limit: 200 },
    ]);
  });
});

describe("metric capacity declarations", () => {
  // REST name to the display name Azure Monitor returns as `name.localizedValue`,
  // from each provider's supported-metrics page (read 2026-11-23).
  const DISPLAY: Record<string, Record<string, string>> = {
    "azure-storage-account": { UsedCapacity: "Used capacity" },
    "azure-redis-cache": { usedmemorypercentage: "Used Memory Percentage" },
    "azure-managed-redis": { usedmemorypercentage: "Used Memory Percentage" },
    "azure-sql-database": {
      storage_percent: "Data space used percent",
      sessions_percent: "Sessions percentage",
      workers_percent: "Workers percentage",
    },
    "azure-postgres-flexible": {
      storage_percent: "Storage percent",
      maximum_used_transactionIDs: "Maximum Used Transaction IDs",
    },
    "azure-mysql-flexible": { storage_percent: "Storage Percent" },
    "azure-aks-cluster": {
      etcd_database_usage_percentage: "ETCD Database Usage Percentage",
      node_disk_usage_percentage: "Disk Used Percentage",
    },
    "azure-firewall": { SNATPortUtilization: "SNAT port utilization" },
    "azure-container-app": { Replicas: "Replica Count" },
  };

  for (const [typeId, names] of Object.entries(DISPLAY)) {
    it(`${typeId} emits every series its capacityMetrics name`, async () => {
      const ctx = {
        get: vi.fn(async (url: string) => {
          const metric = decodeURIComponent(/metricnames=([^&]+)/.exec(url)?.[1] ?? "");
          const display = names[metric];
          if (!display) return { value: [] };
          return {
            value: [
              {
                name: { value: metric, localizedValue: display },
                unit: "Percent",
                timeseries: [
                  { data: [{ timeStamp: "2026-11-23T00:00:00Z", average: 1, maximum: 1 }] },
                ],
              },
            ],
          };
        }),
        subscriptionId: "sub1",
        tenantId: "t1",
      } as unknown as AzureHttpContext;
      const resource = {
        id: `acct:${typeId}:rg1/x1`,
        resourceTypeId: typeId,
        fields: { name: "x1", resourceGroup: "rg1", serverName: "srv" },
        resolvedOutputs: { resourceId: `${SUB}/Some.Provider/things/x1` },
        externalId: "rg1/x1",
      } as unknown as ResourceInstance;
      const series = await fetchAzureMetricSeries(ctx, typeId, resource);
      const labels = new Set(series.map((s) => s.label));
      const declared = typeOf(typeId).capacityMetrics ?? [];
      expect(declared.length).toBeGreaterThan(0);
      for (const metric of declared) expect(labels).toContain(metric.seriesLabel);
    });
  }

  it("resolves the storage account ceiling for standard SKUs only", () => {
    const [decl] = typeOf("azure-storage-account").capacityMetrics!;
    expect(resolveCapacityLimit(decl!.limit, { sku: "Standard_RAGRS" })?.limit).toBe(5 * 1024 ** 5);
    expect(resolveCapacityLimit(decl!.limit, { sku: "Premium_LRS" })).toBeNull();
  });

  it("reads the container app's replica ceiling from maxReplicas", () => {
    const [decl] = typeOf("azure-container-app").capacityMetrics!;
    expect(resolveCapacityLimit(decl!.limit, { maxReplicas: 10 })?.limit).toBe(10);
  });
});
