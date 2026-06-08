import { f, o, rt } from "@infrawrench/plugin-base";

export const CosmosDBAccountResourceType = rt({
  name: "Cosmos DB Account",
  id: "azure-cosmos-db",
  description: "An Azure Cosmos DB account",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("kind", "Kind"),
    f("databaseAccountOfferType", "Offer Type"),
    f("provisioningState", "Provisioning State"),
    f("consistencyLevel", "Consistency Level", { required: false }),
    f("enableAutomaticFailover", "Auto Failover", { kind: "boolean", required: false }),
    f("enableMultipleWriteLocations", "Multi-Region Writes", { kind: "boolean", required: false }),
    f("readLocations", "Read Locations", { required: false }),
    f("writeLocations", "Write Locations", { required: false }),
  ],
  outputs: [
    o("documentEndpoint", "Document Endpoint"),
    o("primaryKey", "Primary Key", { sensitive: true }),
    o("connectionString", "Connection String", { sensitive: true }),
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "mongodb",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MongoDB",
      showWhen: { fieldKey: "kind", equals: "MongoDB" },
    },
  ],
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
});
