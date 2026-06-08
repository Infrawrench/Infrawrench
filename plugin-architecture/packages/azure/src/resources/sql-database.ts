import { f, o, rt } from "@infrawrench/plugin-base";

export const SQLDatabaseResourceType = rt({
  name: "SQL Database",
  id: "azure-sql-database",
  description: "An Azure SQL Database",
  fields: [
    f("name", "Name"),
    f("serverName", "Server"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("status", "Status", {
      kind: "enum",
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
    }),
    f("edition", "Edition", { required: false }),
    f("serviceLevelObjective", "Service Level", { required: false }),
    f("maxSizeBytes", "Max Size (Bytes)", { kind: "number", required: false }),
    f("collation", "Collation", { required: false }),
    f("zoneRedundant", "Zone Redundant", { kind: "boolean", required: false }),
  ],
  outputs: [
    o("connectionString", "Connection String", { sensitive: true }),
    o("serverFqdn", "Server FQDN"),
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "mssql",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MSSQL",
      unreachableWhen: {
        fieldsEmpty: ["serverFqdn"],
        title: "SQL Server has no public endpoint reachable from this host.",
        suggestions: [
          "Connect from inside the same VNet as the SQL server private endpoint.",
          "Enable public network access on the logical server (configure firewall rules).",
          "Use Azure Bastion or a jumpbox in the server's network.",
        ],
      },
    },
  ],
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
});
