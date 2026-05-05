import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const MongoDBDatabaseResourceType: ResourceTypeDefinition = {
  id: "mongodb-database",
  displayName: "MongoDB Database",
  pluralDisplayName: "MongoDB Databases",
  description: "A MongoDB database — browse collections and documents",
  fields: [
    { key: "host", label: "Host", kind: "string", required: false },
    { key: "database", label: "Database", kind: "string", required: true },
    { key: "connectionString", label: "Connection String", kind: "secret", required: true },
  ],
  outputs: [
    { key: "connectionString", label: "Connection String", sensitive: true },
    { key: "serverVersion", label: "Server Version", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsMetrics: true,
  iconKey: "mongodb",
};
