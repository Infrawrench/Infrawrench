import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getRedisCacheCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  return {
    fields: [
      {
        key: "name",
        label: "Redis Cache Name",
        kind: "text",
        required: true,
        description: "Globally unique DNS name",
      },
      {
        key: "resourceGroup",
        label: "Resource Group",
        kind: "select",
        required: true,
        options: rgOptions,
      },
      {
        key: "region",
        label: "Region",
        kind: "region-picker",
        required: true,
        regions: AZURE_REGIONS,
      },
      {
        key: "sku",
        label: "Pricing Tier",
        kind: "select",
        required: true,
        defaultValue: "Basic",
        options: [
          { id: "Basic", label: "Basic" },
          { id: "Standard", label: "Standard" },
          { id: "Premium", label: "Premium" },
        ],
      },
      {
        key: "capacity",
        label: "Cache Size",
        kind: "select",
        required: true,
        defaultValue: "0",
        options: [
          { id: "0", label: "C0 (250 MB)" },
          { id: "1", label: "C1 (1 GB)" },
          { id: "2", label: "C2 (2.5 GB)" },
          { id: "3", label: "C3 (6 GB)" },
          { id: "4", label: "C4 (13 GB)" },
          { id: "5", label: "C5 (26 GB)" },
          { id: "6", label: "C6 (53 GB)" },
        ],
      },
    ],
  };
}

export async function createRedisCache(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const skuName = fields["sku"] ?? "Basic";
  const capacity = Number(fields["capacity"] ?? "0");
  const skuFamily = skuName === "Premium" ? "P" : "C";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Cache/redis/${name}?api-version=2023-08-01`,
    {
      location,
      properties: {
        sku: { name: skuName, family: skuFamily, capacity },
        enableNonSslPort: false,
        redisVersion: "6",
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-redis-cache", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-redis-cache",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku: skuName,
      capacity,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      redisVersion: "6",
      nonSslPort: false,
      shardCount: 0,
    },
    resolvedOutputs: {
      hostName: String(props?.["hostName"] ?? `${name}.redis.cache.windows.net`),
      port: "6380",
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
