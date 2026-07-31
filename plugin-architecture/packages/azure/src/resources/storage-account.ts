import { f, o, rt } from "@infrawrench/plugin-base";

export const StorageAccountResourceType = rt({
  name: "Storage Account",
  id: "azure-storage-account",
  description: "An Azure Storage Account",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("kind", "Kind"),
    f("sku", "SKU"),
    f("provisioningState", "Provisioning State"),
    f("accessTier", "Access Tier", { required: false }),
    f("httpsOnly", "HTTPS Only", { kind: "boolean", required: false }),
    f("primaryLocation", "Primary Location", { required: false }),
    f("statusOfPrimary", "Primary Status", { required: false }),
    f("keyVaultName", "Encryption Key Vault", {
      required: false,
      description: "Key Vault holding the customer-managed encryption key",
    }),
  ],
  outputs: [
    o("primaryBlobEndpoint", "Blob Endpoint"),
    o("primaryKey", "Primary Key", { sensitive: true }),
    o("connectionString", "Connection String", { sensitive: true }),
  ],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
    {
      fieldKey: "keyVaultName",
      targetTypeId: "azure-key-vault",
      targetKey: "name",
      label: "encrypted with",
    },
  ],
  iconKey: "storage",
  supportsStorageBrowser: true,
  supportsCreate: true,
  supportsMetrics: true,
  credentialFormats: [
    {
      id: "connection-string",
      label: "Connection String",
      description:
        "DefaultEndpointsProtocol=https;AccountName=…;AccountKey=… format. Accepted by the Azure SDK, azcopy, Storage Explorer, etc.",
      mediaType: "text",
      filenameTemplate: "{resource}.connection-string",
    },
    {
      id: "access-keys",
      label: "Access Keys",
      description:
        "Both primary and secondary account keys. Rotate by regenerating one while apps use the other.",
      mediaType: "ini",
      filenameTemplate: "{resource}.keys",
    },
  ],
  secretExportTemplates: [
    {
      id: "storage-connection",
      displayName: "Storage Connection",
      description: "Azure Storage Account connection details",
      entries: [
        { envKey: "AZURE_STORAGE_ACCOUNT", outputKey: "primaryBlobEndpoint" },
        { envKey: "AZURE_STORAGE_KEY", outputKey: "primaryKey" },
        { envKey: "AZURE_STORAGE_CONNECTION_STRING", outputKey: "connectionString" },
      ],
    },
  ],
});
