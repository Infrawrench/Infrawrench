import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudSqlInstanceResourceType: ResourceTypeDefinition = {
  id: "cloudsql-instance",
  displayName: "Cloud SQL Instance",
  pluralDisplayName: "Cloud SQL Instances",
  description: "A Google Cloud SQL managed database instance",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "databaseVersion", label: "Database Version", kind: "string", required: false },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "tier", label: "Machine Tier", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "availabilityType", label: "Availability Type", kind: "string", required: false },
    {
      key: "network",
      label: "VPC Network",
      kind: "association",
      required: false,
      description: "VPC network for private IP access",
      allowLiteral: true,
      resolvableOutputKeys: ["selfLink"],
      resolvableFrom: [
        {
          pluginId: "gcp",
          resourceTypeId: "vpc-network",
          outputKey: "selfLink",
        },
      ],
    },
  ],
  outputs: [
    {
      key: "connectionName",
      label: "Connection Name",
      sensitive: false,
      description: "project:region:instance",
    },
    { key: "ipAddress", label: "IP Address", sensitive: false },
    {
      key: "connectionUrl",
      label: "Connection URL",
      sensitive: true,
      description: "Full database connection URL with embedded credentials",
    },
    { key: "username", label: "Username", sensitive: false },
    { key: "password", label: "Password", sensitive: true },
    { key: "port", label: "Port", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  peerIntegrations: [
    {
      pluginId: "postgres",
      tabLabel: "PostgreSQL",
      credentialMappings: [{ outputKey: "connectionUrl", credentialKey: "connectionString" }],
      showWhen: { fieldKey: "databaseVersion", prefix: "POSTGRES_" },
    },
    {
      pluginId: "mysql",
      tabLabel: "MySQL",
      credentialMappings: [{ outputKey: "connectionUrl", credentialKey: "connectionString" }],
      showWhen: { fieldKey: "databaseVersion", prefix: "MYSQL_" },
    },
    {
      pluginId: "mssql",
      tabLabel: "SQL Server",
      credentialMappings: [{ outputKey: "connectionUrl", credentialKey: "connectionString" }],
      showWhen: { fieldKey: "databaseVersion", prefix: "SQLSERVER_" },
    },
  ],
  secretExportTemplates: [
    {
      id: "cloudsql-connection-url",
      displayName: "Database URL",
      description: "Full database connection URL (postgres://, mysql://, or sqlserver://)",
      entries: [
        {
          envKey: "DATABASE_URL",
          outputKey: "connectionUrl",
          description: "Engine-specific connection URL with credentials",
        },
      ],
    },
    {
      id: "cloudsql-connection",
      displayName: "Cloud SQL Connection",
      description: "Connection name and IP address for Cloud SQL proxy or direct access",
      entries: [
        {
          envKey: "CLOUDSQL_CONNECTION_NAME",
          outputKey: "connectionName",
          description: "project:region:instance format",
        },
        { envKey: "DB_HOST", outputKey: "ipAddress" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
      ],
    },
  ],
};
