import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const StorageAccountResourceType: ResourceTypeDefinition = {
  id: "azure-storage-account",
  displayName: "Storage Account",
  pluralDisplayName: "Storage Accounts",
  description: "An Azure Storage Account",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "kind", label: "Kind", kind: "string", required: true },
    { key: "sku", label: "SKU", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "accessTier", label: "Access Tier", kind: "string", required: false },
    { key: "httpsOnly", label: "HTTPS Only", kind: "boolean", required: false },
    { key: "primaryLocation", label: "Primary Location", kind: "string", required: false },
    { key: "statusOfPrimary", label: "Primary Status", kind: "string", required: false },
  ],
  outputs: [
    { key: "primaryBlobEndpoint", label: "Blob Endpoint", sensitive: false },
    { key: "primaryKey", label: "Primary Key", sensitive: true },
    { key: "connectionString", label: "Connection String", sensitive: true },
  ],
  dashboardPinnable: true,
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
};
