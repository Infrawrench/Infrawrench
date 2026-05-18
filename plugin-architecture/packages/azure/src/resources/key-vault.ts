import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const KeyVaultResourceType: ResourceTypeDefinition = {
  id: "azure-key-vault",
  displayName: "Key Vault",
  pluralDisplayName: "Key Vaults",
  description: "An Azure Key Vault for managing secrets, keys, and certificates",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "sku", label: "SKU", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: false },
    { key: "enableSoftDelete", label: "Soft Delete", kind: "boolean", required: false },
    { key: "enablePurgeProtection", label: "Purge Protection", kind: "boolean", required: false },
    { key: "enableRbacAuthorization", label: "RBAC Auth", kind: "boolean", required: false },
  ],
  outputs: [{ key: "vaultUri", label: "Vault URI", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "secret",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "key-vault-uri",
      displayName: "Key Vault URI",
      description: "Vault URI for SDK / azure-cli access",
      entries: [{ envKey: "AZURE_KEY_VAULT_URI", outputKey: "vaultUri" }],
    },
  ],
};
