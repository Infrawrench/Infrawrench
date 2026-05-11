import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { AZURE_REGIONS } from "./regions.js";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";

export async function getKeyVaultCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const rgOptions = await fetchResourceGroups(ctx);
  return {
    fields: [
      {
        key: "name",
        label: "Key Vault Name",
        kind: "text",
        required: true,
        description: "Globally unique name (3-24 alphanumeric characters and hyphens)",
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
        defaultValue: "standard",
        options: [
          { id: "standard", label: "Standard" },
          { id: "premium", label: "Premium (HSM-backed keys)" },
        ],
      },
      {
        key: "enableSoftDelete",
        label: "Soft Delete",
        kind: "select",
        required: true,
        defaultValue: "true",
        options: [
          { id: "true", label: "Enabled (recommended)" },
          { id: "false", label: "Disabled" },
        ],
      },
    ],
  };
}

export async function createKeyVault(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const location = fields["region"]!;
  const sku = fields["sku"] ?? "standard";
  const enableSoftDelete = fields["enableSoftDelete"] !== "false";

  const result = await ctx.put<Record<string, unknown>>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.KeyVault/vaults/${name}?api-version=2023-07-01`,
    {
      location,
      properties: {
        tenantId: ctx.tenantId,
        sku: { family: "A", name: sku },
        enableSoftDelete,
        enableRbacAuthorization: true,
        accessPolicies: [],
      },
    },
  );
  const props = result["properties"] as Record<string, unknown> | undefined;
  return {
    id: ctx.makeId(accountId, "azure-key-vault", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-key-vault",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      sku,
      provisioningState: String(props?.["provisioningState"] ?? "Creating"),
      vaultUri: String(props?.["vaultUri"] ?? `https://${name}.vault.azure.net/`),
      enableSoftDelete,
    },
    resolvedOutputs: {
      vaultUri: String(props?.["vaultUri"] ?? `https://${name}.vault.azure.net/`),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
