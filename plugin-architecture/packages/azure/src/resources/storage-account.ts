import { f, o, rt } from "@infrawrench/plugin-base";

/** 5 PiB, the default maximum capacity of a standard storage account. */
const STANDARD_ACCOUNT_CAPACITY = 5 * 1024 ** 5;

export const StorageAccountResourceType = rt({
  name: "Storage Account",
  id: "azure-storage-account",
  description: "An Azure Storage Account",
  equivalence: "object-storage",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location", { showcase: true, sizing: "region" }),
    f("kind", "Kind", { showcase: true }),
    f("sku", "SKU", { showcase: true }),
    f("provisioningState", "Provisioning State", { showcase: true }),
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
  // Blob, static-website and the other service endpoints all hang off the
  // globally-unique account name: `<account>.blob.core.windows.net`,
  // `<account>.z13.web.core.windows.net`.
  dnsServiceHosts: [
    {
      id: "storage-endpoint",
      label: "Storage account endpoint",
      hostPattern: String.raw`([a-z0-9]+)\.(?:blob|file|queue|table|dfs|z[0-9]+\.web)\.core\.windows\.net`,
      reason:
        "Storage account names are globally unique and released on delete, so any Azure customer can create an account with the same name and serve their blobs from your hostname.",
    },
  ],
  supportsStorageBrowser: true,
  supportsCreate: true,
  supportsMetrics: true,
  // `fetchAzureMetricSeries` labels a series with Azure Monitor's display name:
  // "Used capacity" for `UsedCapacity` (Bytes) at
  // https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-storage-storageaccounts-metrics
  // The ceiling is the "Default maximum storage account capacity: 5 PiB" for standard
  // (GPv2, GPv1, Blob Storage) accounts; premium accounts are sized differently and
  // get no row. Support can raise it. Read 2026-11-23 at
  // https://learn.microsoft.com/azure/storage/common/scalability-targets-standard-account
  capacityMetrics: [
    {
      seriesLabel: "Used capacity",
      limit: {
        plan: {
          field: "sku",
          allowances: {
            Standard_LRS: STANDARD_ACCOUNT_CAPACITY,
            Standard_GRS: STANDARD_ACCOUNT_CAPACITY,
            Standard_RAGRS: STANDARD_ACCOUNT_CAPACITY,
            Standard_ZRS: STANDARD_ACCOUNT_CAPACITY,
            Standard_GZRS: STANDARD_ACCOUNT_CAPACITY,
            Standard_RAGZRS: STANDARD_ACCOUNT_CAPACITY,
          },
        },
      },
      unit: "bytes",
      label: "Account capacity",
    },
  ],
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
  postureChecks: [
    {
      id: "azure-storage-http-allowed",
      title: "Plain HTTP transfer allowed",
      severity: "high",
      category: "encryption",
      conditions: [{ fieldKey: "httpsOnly", when: "falsy" }],
      reason:
        '"Secure transfer required" is off, so clients can read and write blobs over unencrypted HTTP.',
    },
  ],
});
