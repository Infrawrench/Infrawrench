import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getVNetCreateConfig(ctx: AzureCreateContext): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "VNet Name",
        kind: "text",
        required: true,
        description: "Name for the virtual network",
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
        key: "addressSpace",
        label: "Address Space (CIDR)",
        kind: "text",
        required: true,
        defaultValue: "10.0.0.0/16",
        description: "IPv4 address range in CIDR notation",
      },
      {
        key: "subnetName",
        label: "Default Subnet Name",
        kind: "text",
        required: true,
        defaultValue: "default",
      },
      {
        key: "subnetPrefix",
        label: "Subnet Address Prefix",
        kind: "text",
        required: true,
        defaultValue: "10.0.0.0/24",
      },
    ],
  };
}

export async function createVNet(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const addressSpace = fields["addressSpace"] ?? "10.0.0.0/16";
  const subnetName = fields["subnetName"] ?? "default";
  const subnetPrefix = fields["subnetPrefix"] ?? "10.0.0.0/24";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${name}?api-version=2023-09-01`,
    {
      location,
      properties: {
        addressSpace: { addressPrefixes: [addressSpace] },
        subnets: [{ name: subnetName, properties: { addressPrefix: subnetPrefix } }],
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-vnet", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-vnet",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      addressSpace,
      subnetCount: 1,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
