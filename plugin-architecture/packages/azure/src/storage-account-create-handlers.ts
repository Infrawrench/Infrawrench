import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getStorageAccountCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);

  return {
    fields: [
      {
        key: "name",
        label: "Storage Account Name",
        kind: "text",
        required: true,
        description: "Globally unique name (3-24 lowercase letters/numbers)",
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
        label: "Performance / Replication",
        kind: "select",
        required: true,
        defaultValue: "Standard_LRS",
        options: [
          { id: "Standard_LRS", label: "Standard LRS" },
          { id: "Standard_GRS", label: "Standard GRS" },
          { id: "Standard_ZRS", label: "Standard ZRS" },
          { id: "Standard_RAGRS", label: "Standard RA-GRS" },
          { id: "Premium_LRS", label: "Premium LRS" },
        ],
      },
      {
        key: "kind",
        label: "Kind",
        kind: "select",
        required: true,
        defaultValue: "StorageV2",
        options: [
          { id: "StorageV2", label: "General Purpose v2" },
          { id: "BlobStorage", label: "Blob Storage" },
          { id: "BlockBlobStorage", label: "Block Blob Storage" },
        ],
      },
    ],
  };
}

export async function createStorageAccount(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "Standard_LRS";
  const kind = fields["kind"] ?? "StorageV2";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${name}?api-version=2023-01-01`,
    {
      location,
      kind,
      sku: { name: sku },
      properties: { supportsHttpsTrafficOnly: true, accessTier: "Hot" },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  const primaryEndpoints = props?.["primaryEndpoints"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-storage-account", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-storage-account",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      kind,
      sku,
      provisioningState: String(props?.["provisioningState"] ?? "Succeeded"),
      accessTier: "Hot",
      httpsOnly: true,
      primaryLocation: location,
      statusOfPrimary: "available",
    },
    resolvedOutputs: {
      primaryBlobEndpoint: String(
        primaryEndpoints?.["blob"] ?? `https://${name}.blob.core.windows.net/`,
      ),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
