import { f, o, rt } from "@infrawrench/plugin-base";

export const RDSClusterResourceType = rt({
  name: "Aurora Cluster",
  id: "rds-cluster",
  description: "An Amazon Aurora DB cluster",
  fields: [
    f("clusterIdentifier", "Cluster ID"),
    f("engine", "Engine", { kind: "enum", enumValues: ["aurora-mysql", "aurora-postgresql"] }),
    f("engineVersion", "Engine Version"),
    f("status", "Status"),
    f("multiAZ", "Multi-AZ", { kind: "boolean", required: false }),
    f("storageEncrypted", "Encrypted", { kind: "boolean", required: false }),
    f("allocatedStorage", "Storage (GB)", { kind: "number", required: false }),
    f("dbClusterMembers", "Members", { kind: "number", required: false }),
  ],
  outputs: [
    o("endpoint", "Writer Endpoint"),
    o("readerEndpoint", "Reader Endpoint"),
    o("port", "Port"),
    o("masterUsername", "Master Username"),
    o("clusterArn", "Cluster ARN"),
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "Database connection URI (constructed from endpoint + port)",
    }),
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "engine", equals: "aurora-postgresql" },
      unreachableWhen: {
        fieldsEmpty: ["endpoint"],
        title: "Cluster writer endpoint is not reachable from this host.",
        suggestions: [
          "Aurora clusters are typically VPC-only — connect from inside the VPC or via an SSH tunnel.",
          "Enable publicly accessible on the cluster instances (not recommended in production).",
          "Use an EC2 bastion in the same VPC.",
        ],
      },
    },
    {
      pluginId: "mysql",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MySQL",
      showWhen: { fieldKey: "engine", equals: "aurora-mysql" },
      unreachableWhen: {
        fieldsEmpty: ["endpoint"],
        title: "Cluster writer endpoint is not reachable from this host.",
        suggestions: [
          "Aurora clusters are typically VPC-only — connect from inside the VPC or via an SSH tunnel.",
          "Enable publicly accessible on the cluster instances (not recommended in production).",
          "Use an EC2 bastion in the same VPC.",
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "database-url",
      displayName: "Database URL",
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
      id: "aurora-connection",
      displayName: "Aurora Connection",
      description: "Connection details for this Aurora cluster",
      entries: [
        { envKey: "DB_HOST", outputKey: "endpoint" },
        { envKey: "DB_READER_HOST", outputKey: "readerEndpoint" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "masterUsername" },
      ],
    },
  ],
});
