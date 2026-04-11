import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CosmosDBAccountResourceType: ResourceTypeDefinition = {
  id: "azure-cosmos-db",
  displayName: "Cosmos DB Account",
  pluralDisplayName: "Cosmos DB Accounts",
  description: "An Azure Cosmos DB account",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "kind", label: "Kind", kind: "string", required: true },
    { key: "databaseAccountOfferType", label: "Offer Type", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "consistencyLevel", label: "Consistency Level", kind: "string", required: false },
    { key: "enableAutomaticFailover", label: "Auto Failover", kind: "boolean", required: false },
    {
      key: "enableMultipleWriteLocations",
      label: "Multi-Region Writes",
      kind: "boolean",
      required: false,
    },
    { key: "readLocations", label: "Read Locations", kind: "string", required: false },
    { key: "writeLocations", label: "Write Locations", kind: "string", required: false },
  ],
  outputs: [
    { key: "documentEndpoint", label: "Document Endpoint", sensitive: false },
    { key: "primaryKey", label: "Primary Key", sensitive: true },
    { key: "connectionString", label: "Connection String", sensitive: true },
  ],
  dashboardPinnable: true,
  iconKey: "database",
  supportsCreate: true,
  secretExportTemplates: [
    {
      id: "cosmos-connection",
      displayName: "Cosmos DB Connection",
      description: "Connection details for Azure Cosmos DB",
      entries: [
        { envKey: "COSMOS_ENDPOINT", outputKey: "documentEndpoint" },
        { envKey: "COSMOS_KEY", outputKey: "primaryKey" },
        { envKey: "COSMOS_CONNECTION_STRING", outputKey: "connectionString" },
      ],
    },
  ],
};
