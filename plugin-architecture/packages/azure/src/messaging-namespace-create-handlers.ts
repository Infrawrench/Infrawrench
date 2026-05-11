import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getMessagingNamespaceCreateConfig(
  ctx: AzureCreateContext,
  label: string,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: `${label} Name`,
        kind: "text",
        required: true,
        description: "Globally unique namespace name",
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
        defaultValue: "Standard",
        options: [
          { id: "Basic", label: "Basic" },
          { id: "Standard", label: "Standard" },
          { id: "Premium", label: "Premium" },
        ],
      },
    ],
  };
}

export async function createMessagingNamespace(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
  typeId: string,
  provider: string,
  apiVersion: string,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "Standard";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/${provider}/${name}?api-version=${apiVersion}`,
    {
      location,
      sku: { name: sku, tier: sku },
      properties: {},
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, typeId, `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: typeId,
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      status: String(props?.["status"] ?? ""),
    },
    resolvedOutputs: {
      serviceBusEndpoint: String(props?.["serviceBusEndpoint"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
