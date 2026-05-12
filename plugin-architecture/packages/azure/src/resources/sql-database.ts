import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SQLDatabaseResourceType: ResourceTypeDefinition = {
  id: "azure-sql-database",
  displayName: "SQL Database",
  pluralDisplayName: "SQL Databases",
  description: "An Azure SQL Database",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "serverName", label: "Server", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      required: true,
      enumValues: [
        "Online",
        "Creating",
        "Copying",
        "OnlineChangingDwPerformanceTiers",
        "Offline",
        "Pausing",
        "Paused",
        "Resuming",
        "Scaling",
        "Suspect",
        "Inaccessible",
      ],
    },
    { key: "edition", label: "Edition", kind: "string", required: false },
    { key: "serviceLevelObjective", label: "Service Level", kind: "string", required: false },
    { key: "maxSizeBytes", label: "Max Size (Bytes)", kind: "number", required: false },
    { key: "collation", label: "Collation", kind: "string", required: false },
    { key: "zoneRedundant", label: "Zone Redundant", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "connectionString", label: "Connection String", sensitive: true },
    { key: "serverFqdn", label: "Server FQDN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "database",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "connection-string",
      displayName: "SQL Connection String",
      description: "Connection string for Azure SQL Database",
      entries: [
        { envKey: "DATABASE_URL", outputKey: "connectionString" },
        { envKey: "DB_HOST", outputKey: "serverFqdn" },
      ],
    },
  ],
};
