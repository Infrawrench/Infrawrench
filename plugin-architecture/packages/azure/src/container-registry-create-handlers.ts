import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getContainerRegistryCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "Registry Name",
        kind: "text",
        required: true,
        description: "Globally unique name (5-50 alphanumeric characters)",
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
        defaultValue: "Basic",
        options: [
          { id: "Basic", label: "Basic (~$0.167/day)" },
          { id: "Standard", label: "Standard (~$0.667/day)" },
          { id: "Premium", label: "Premium (~$1.667/day, geo-replication)" },
        ],
      },
      {
        key: "adminEnabled",
        label: "Admin User",
        kind: "select",
        required: true,
        defaultValue: "false",
        options: [
          { id: "false", label: "Disabled" },
          { id: "true", label: "Enabled" },
        ],
      },
    ],
  };
}

export async function createContainerRegistry(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "Basic";
  const adminEnabled = fields["adminEnabled"] === "true";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.ContainerRegistry/registries/${name}?api-version=2023-07-01`,
    {
      location,
      sku: { name: sku },
      properties: { adminUserEnabled: adminEnabled },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-container-registry", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-container-registry",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku,
      loginServer: String(props?.["loginServer"] ?? `${name.toLowerCase()}.azurecr.io`),
      adminEnabled,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
    },
    resolvedOutputs: {
      loginServer: String(props?.["loginServer"] ?? `${name.toLowerCase()}.azurecr.io`),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
