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
  ],
  dashboardPinnable: true,
  iconKey: "database",
  supportsCreate: true,
  resourceSqlDriver: {
    driver: "postgres",
    connectionStringOutputKey: "endpoint",
  },
  secretExportTemplates: [
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
