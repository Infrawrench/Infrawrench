import { f, o, rt } from "@infrawrench/plugin-base";

export const KeyVaultResourceType = rt({
  name: "Key Vault",
  id: "azure-key-vault",
  description: "An Azure Key Vault for managing secrets, keys, and certificates",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("sku", "SKU"),
    f("provisioningState", "Provisioning State", { required: false }),
    f("enableSoftDelete", "Soft Delete", { kind: "boolean", required: false }),
    f("enablePurgeProtection", "Purge Protection", { kind: "boolean", required: false }),
    f("enableRbacAuthorization", "RBAC Auth", { kind: "boolean", required: false }),
  ],
  outputs: [o("vaultUri", "Vault URI")],
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
});
