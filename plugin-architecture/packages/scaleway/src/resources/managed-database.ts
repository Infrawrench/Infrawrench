import { f, o, rt } from "@infrawrench/plugin-base";

const connectionMapping = [{ outputKey: "connectionString", credentialKey: "connectionString" }];

export const ManagedDatabaseResourceType = rt({
  id: "rdb-instance",
  name: "Managed Database",
  description: "A Scaleway Managed Database (RDB) instance",
  fields: [
    f("name", "Name"),
    f("engine", "Engine", { kind: "enum", enumValues: ["PostgreSQL", "MySQL", "Redis"] }),
    f("engineVersion", "Engine Version"),
    f("region", "Region", { kind: "enum", enumValues: ["fr-par", "nl-ams", "pl-waw"] }),
    f("nodeType", "Node Type", { description: "Instance node type, e.g. DB-DEV-S, DB-GP-XS" }),
    f("status", "Status", { required: false }),
  ],
  outputs: [
    o("host", "Host"),
    o("port", "Port"),
    o("username", "Username"),
    o("password", "Password", { sensitive: true }),
    o("dbName", "Database Name"),
    o("connectionString", "Connection String", { sensitive: true }),
  ],
  supportsCreate: true,
  iconKey: "database",
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: connectionMapping,
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "engine", equals: "PostgreSQL" },
    },
    {
      pluginId: "mysql",
      credentialMappings: connectionMapping,
      tabLabel: "MySQL",
      showWhen: { fieldKey: "engine", equals: "MySQL" },
    },
    {
      pluginId: "redis",
      credentialMappings: connectionMapping,
      tabLabel: "Redis",
      showWhen: { fieldKey: "engine", equals: "Redis" },
    },
  ],
  secretExportTemplates: [
    {
      id: "url",
      displayName: "Connection URL",
      description: "Single DATABASE_URL containing the full connection string",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
    {
      id: "individual",
      displayName: "Individual Credentials",
      description: "Separate environment variables for host, port, user, password, and database",
      entries: [
        { envKey: "DB_HOST", outputKey: "host" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
        { envKey: "DB_NAME", outputKey: "dbName" },
      ],
    },
  ],
});
