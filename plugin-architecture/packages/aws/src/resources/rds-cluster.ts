import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const RDSClusterResourceType: ResourceTypeDefinition = {
  id: "rds-cluster",
  displayName: "Aurora Cluster",
  pluralDisplayName: "Aurora Clusters",
  description: "An Amazon Aurora DB cluster",
  fields: [
    { key: "clusterIdentifier", label: "Cluster ID", kind: "string", required: true },
    {
      key: "engine",
      label: "Engine",
      kind: "enum",
      required: true,
      enumValues: ["aurora-mysql", "aurora-postgresql"],
    },
    { key: "engineVersion", label: "Engine Version", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "multiAZ", label: "Multi-AZ", kind: "boolean", required: false },
    { key: "storageEncrypted", label: "Encrypted", kind: "boolean", required: false },
    { key: "allocatedStorage", label: "Storage (GB)", kind: "number", required: false },
    { key: "dbClusterMembers", label: "Members", kind: "number", required: false },
  ],
  outputs: [
    { key: "endpoint", label: "Writer Endpoint", sensitive: false },
    { key: "readerEndpoint", label: "Reader Endpoint", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    { key: "masterUsername", label: "Master Username", sensitive: false },
    { key: "clusterArn", label: "Cluster ARN", sensitive: false },
    {
      key: "connectionString",
      label: "Connection String",
      sensitive: true,
      description: "Database connection URI (constructed from endpoint + port)",
    },
  ],
  dashboardPinnable: true,
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
};
