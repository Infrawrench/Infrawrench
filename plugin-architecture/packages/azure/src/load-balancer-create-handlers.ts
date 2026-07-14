import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getLoadBalancerCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "Load Balancer Name",
        kind: "text",
        required: true,
        description: "Name for the load balancer",
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
        label: "SKU",
        kind: "select",
        required: true,
        options: [
          { id: "Standard", label: "Standard" },
          { id: "Basic", label: "Basic" },
        ],
        defaultValue: "Standard",
      },
    ],
  };
}

export async function createLoadBalancer(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "Standard";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/loadBalancers/${name}?api-version=2023-09-01`,
    {
      location,
      sku: { name: sku },
      properties: {},
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-load-balancer", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-load-balancer",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      frontendIpCount: 0,
      backendPoolCount: 0,
      ruleCount: 0,
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
