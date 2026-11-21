import { f, o, rt } from "@infrawrench/plugin-base";

// `cloud.project.database.EngineEnum` today, plus the engines OVH has
// retired (redis, cassandra, m3db) so services synced before then still
// validate. Valkey replaced Redis.
const ENGINES = [
  "postgresql",
  "mysql",
  "mongodb",
  "valkey",
  "kafka",
  "kafkaConnect",
  "kafkaMirrorMaker",
  "opensearch",
  "clickhouse",
  "grafana",
  "redis",
  "cassandra",
  "m3db",
];
const connectionMapping = [{ outputKey: "connectionString", credentialKey: "connectionString" }];

export const ManagedDbResourceType = rt({
  id: "managed-db",
  name: "Managed Database",
  description: "An OVHcloud Public Cloud managed database service",
  // Valkey replaced Redis, so a new Redis-compatible service is ordered as
  // `valkey`; services synced before the switch still read `redis`.
  equivalence: [
    {
      category: "managed-postgres",
      when: { fieldKey: "engine", oneOf: ["postgresql"] },
      createFields: { engine: "postgresql" },
    },
    {
      category: "managed-mysql",
      when: { fieldKey: "engine", oneOf: ["mysql"] },
      createFields: { engine: "mysql" },
    },
    {
      category: "managed-redis",
      when: { fieldKey: "engine", oneOf: ["valkey", "redis"] },
      createFields: { engine: "valkey" },
    },
    {
      category: "managed-mongodb",
      when: { fieldKey: "engine", oneOf: ["mongodb"] },
      createFields: { engine: "mongodb" },
    },
  ],
  fields: [
    f("description", "Name"),
    f("engine", "Engine", { kind: "enum", enumValues: ENGINES, editable: false }),
    f("version", "Version", {
      description: "Engine version, e.g. 16 for PostgreSQL 16. Changing it upgrades the service",
    }),
    f("plan", "Plan", {
      showcase: true,
      description:
        "Service plan, e.g. discovery, production, advanced. Changing it migrates the service",
    }),
    f("region", "Region", { showcase: true, editable: false, sizing: "region" }),
    f("flavor", "Flavor", {
      description: "Node flavor, e.g. b3-8. Changing it resizes every node",
      sizing: "instance-type",
    }),
    f("nodeCount", "Node Count", {
      showcase: true,
      kind: "number",
      editable: false,
      sizing: "node-count",
    }),
    f("status", "Status", { showcase: true, required: false, editable: false }),
    f("storageSizeGb", "Storage (GB)", {
      kind: "number",
      required: false,
      editable: false,
      sizing: "disk-gb",
    }),
    f("deletionProtection", "Deletion Protection", { kind: "boolean", required: false }),
    f("backupTime", "Backup Time", {
      required: false,
      description: "UTC time daily backups start, e.g. 02:00:00",
      editable: false,
    }),
    f("backupRetentionDays", "Backup Retention (days)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("maintenanceTime", "Maintenance Time", { required: false, editable: false }),
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
  // Edit = `PUT /database/{engine}/{id}`: description, version, plan, flavor
  // and deletion protection.
  supportsUpdate: true,
  supportsMetrics: true,
  backupPolicy: { protectedBy: [], retentionDaysFieldKey: "backupRetentionDays" },
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
      // Valkey speaks the Redis protocol; the Redis plugin drives it.
      pluginId: "redis",
      credentialMappings: connectionMapping,
      tabLabel: "Valkey",
      showWhen: { fieldKey: "engine", equals: "valkey" },
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
