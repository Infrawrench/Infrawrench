import { f, o, rt } from "@infrawrench/plugin-base";

const ENGINES = [
  "postgresql",
  "mysql",
  "mongodb",
  "redis",
  "kafka",
  "opensearch",
  "cassandra",
  "m3db",
  "grafana",
];
const connectionMapping = [{ outputKey: "connectionString", credentialKey: "connectionString" }];

export const ManagedDbResourceType = rt({
  id: "managed-db",
  name: "Managed Database",
  description: "An OVHcloud Public Cloud managed database service",
  fields: [
    f("description", "Name"),
    f("engine", "Engine", { kind: "enum", enumValues: ENGINES }),
    f("version", "Version", { description: "Engine version, e.g. 16 for PostgreSQL 16" }),
    f("plan", "Plan", { description: "Service plan, e.g. essential, business, enterprise" }),
    f("region", "Region"),
    f("flavor", "Flavor", { description: "Node flavor, e.g. db1-7" }),
    f("nodeCount", "Node Count", { kind: "number" }),
    f("status", "Status", { required: false }),
  ],
  outputs: [
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "Full connection URI",
    }),
    o("host", "Host"),
    o("port", "Port"),
    o("username", "Username"),
    o("password", "Password", { sensitive: true }),
    o("database", "Database Name"),
  ],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "database",
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: connectionMapping,
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "engine", equals: "postgresql" },
    },
    {
      pluginId: "mysql",
      credentialMappings: connectionMapping,
      tabLabel: "MySQL",
      showWhen: { fieldKey: "engine", equals: "mysql" },
    },
    {
      pluginId: "redis",
      credentialMappings: connectionMapping,
      tabLabel: "Redis",
      showWhen: { fieldKey: "engine", equals: "redis" },
    },
    {
      pluginId: "mongodb",
      credentialMappings: connectionMapping,
      tabLabel: "MongoDB",
      showWhen: { fieldKey: "engine", equals: "mongodb" },
    },
    {
      pluginId: "opensearch",
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "endpoint" },
        { outputKey: "username", credentialKey: "username" },
        { outputKey: "password", credentialKey: "password" },
      ],
      tabLabel: "OpenSearch",
      showWhen: { fieldKey: "engine", equals: "opensearch" },
    },
    {
      pluginId: "kafka",
      credentialMappings: connectionMapping,
      tabLabel: "Kafka",
      showWhen: { fieldKey: "engine", equals: "kafka" },
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "Single DATABASE_URL containing the full connection string",
      entries: [
        {
          envKey: "DATABASE_URL",
          outputKey: "connectionString",
          description: "Full connection URI",
        },
      ],
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
        { envKey: "DB_NAME", outputKey: "database" },
      ],
    },
  ],
});
