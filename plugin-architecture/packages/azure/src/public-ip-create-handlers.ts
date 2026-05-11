import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getPublicIPCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      { key: "name", label: "Public IP Name", kind: "text", required: true },
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
        defaultValue: "Standard",
        options: [
          { id: "Basic", label: "Basic" },
          { id: "Standard", label: "Standard" },
        ],
      },
      {
        key: "allocationMethod",
        label: "Allocation",
        kind: "select",
        required: true,
        defaultValue: "Static",
        options: [
          { id: "Static", label: "Static" },
          { id: "Dynamic", label: "Dynamic" },
        ],
      },
      {
        key: "ipVersion",
        label: "IP Version",
        kind: "select",
        required: true,
        defaultValue: "IPv4",
        options: [
          { id: "IPv4", label: "IPv4" },
          { id: "IPv6", label: "IPv6" },
        ],
      },
    ],
  };
}

export async function createPublicIP(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "Standard";
  const allocationMethod = fields["allocationMethod"] ?? "Static";
  const ipVersion = fields["ipVersion"] ?? "IPv4";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/publicIPAddresses/${name}?api-version=2023-09-01`,
    {
      location,
      sku: { name: sku },
      properties: {
        publicIPAllocationMethod: allocationMethod,
        publicIPAddressVersion: ipVersion,
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-public-ip", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-public-ip",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku,
      allocationMethod,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      ipVersion,
    },
    resolvedOutputs: {
      ipAddress: String(props?.["ipAddress"] ?? ""),
      fqdn: String((props?.["dnsSettings"] as Record<string, unknown> | undefined)?.["fqdn"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
