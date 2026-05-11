import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getLogAnalyticsCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "Workspace Name",
        kind: "text",
        required: true,
        description: "Name for the Log Analytics workspace",
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
        defaultValue: "PerGB2018",
        options: [
          { id: "PerGB2018", label: "Pay-as-you-go (Per GB)" },
          { id: "Free", label: "Free (500 MB/day limit)" },
          { id: "Standalone", label: "Standalone" },
          { id: "PerNode", label: "Per Node (OMS)" },
        ],
      },
      {
        key: "retentionInDays",
        label: "Data Retention",
        kind: "select",
        required: true,
        defaultValue: "30",
        options: [
          { id: "30", label: "30 days" },
          { id: "60", label: "60 days" },
          { id: "90", label: "90 days" },
          { id: "120", label: "120 days" },
          { id: "180", label: "180 days" },
          { id: "365", label: "365 days" },
        ],
      },
    ],
  };
}

export async function createLogAnalyticsWorkspace(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "PerGB2018";
  const retentionInDays = Number(fields["retentionInDays"] ?? "30");

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.OperationalInsights/workspaces/${name}?api-version=2022-10-01`,
    {
      location,
      properties: {
        sku: { name: sku },
        retentionInDays,
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-log-analytics", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-log-analytics",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      retentionInDays,
      dailyQuotaGb: -1,
    },
    resolvedOutputs: {
      customerId: String(props?.["customerId"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
