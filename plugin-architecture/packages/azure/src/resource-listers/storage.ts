import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, extractResourceGroup, extractVaultName, type ListerContext } from "./shared.js";

export async function listStorageAccounts(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Storage/storageAccounts?api-version=2023-01-01`,
  );
  return (data.value ?? []).map((sa) => {
    const name = String(sa["name"] ?? "");
    const azureId = String(sa["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = sa["properties"] as Record<string, unknown> | undefined;
    const primaryEndpoints = props?.["primaryEndpoints"] as Record<string, unknown> | undefined;
    const sku = sa["sku"] as Record<string, unknown> | undefined;
    // The Storage RP spells the CMK block lowercase; accept both spellings.
    const encryption = props?.["encryption"] as Record<string, unknown> | undefined;
    const kvProps = (encryption?.["keyvaultproperties"] ?? encryption?.["keyVaultProperties"]) as
      | Record<string, unknown>
      | undefined;
    const keyVaultName = extractVaultName(
      String(kvProps?.["keyvaulturi"] ?? kvProps?.["keyVaultUri"] ?? ""),
    );

    return {
      id: ctx.id(accountId, "azure-storage-account", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-storage-account",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(sa["location"] ?? ""),
        kind: String(sa["kind"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        accessTier: String(props?.["accessTier"] ?? ""),
        httpsOnly: (props?.["supportsHttpsTrafficOnly"] as boolean) ?? true,
        primaryLocation: String(props?.["primaryLocation"] ?? ""),
        statusOfPrimary: String(props?.["statusOfPrimary"] ?? ""),
        keyVaultName,
      },
      resolvedOutputs: {
        primaryBlobEndpoint: String(primaryEndpoints?.["blob"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["creationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listKeyVaults(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.KeyVault/vaults?api-version=2023-07-01&$top=100`,
  );
  return (data.value ?? []).map((vault) => {
    const name = String(vault["name"] ?? "");
    const azureId = String(vault["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = vault["properties"] as Record<string, unknown> | undefined;
    const sku = props?.["sku"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-key-vault", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-key-vault",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(vault["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        enableSoftDelete: (props?.["enableSoftDelete"] as boolean) ?? true,
        enablePurgeProtection: (props?.["enablePurgeProtection"] as boolean) ?? false,
        enableRbacAuthorization: (props?.["enableRbacAuthorization"] as boolean) ?? false,
      },
      resolvedOutputs: {
        vaultUri: String(props?.["vaultUri"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}
