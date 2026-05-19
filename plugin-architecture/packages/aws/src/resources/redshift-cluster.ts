import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const RedshiftClusterResourceType: ResourceTypeDefinition = {
  id: "redshift-cluster",
  displayName: "Redshift Cluster",
  pluralDisplayName: "Redshift Clusters",
  description: "An Amazon Redshift data warehouse cluster",
  fields: [
    { key: "clusterIdentifier", label: "Cluster ID", kind: "string", required: true },
    { key: "nodeType", label: "Node Type", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "numberOfNodes", label: "Nodes", kind: "number", required: true },
    { key: "dbName", label: "Database Name", kind: "string", required: false },
    { key: "availabilityZone", label: "Availability Zone", kind: "string", required: false },
    { key: "encrypted", label: "Encrypted", kind: "boolean", required: false },
    { key: "publiclyAccessible", label: "Publicly Accessible", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "endpoint", label: "Endpoint", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    { key: "masterUsername", label: "Master Username", sensitive: false },
    { key: "clusterArn", label: "Cluster ARN", sensitive: false },
    {
      key: "connectionString",
      label: "Connection String",
      sensitive: true,
      description: "PostgreSQL connection URI for Redshift (constructed from endpoint + port)",
    },
  ],
  dashboardPinnable: true,
  iconKey: "database",
  supportsCreate: true,
  supportsMetrics: true,
  resourceSqlDriver: {
    driver: "postgres",
    connectionStringOutputKey: "connectionString",
  },
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "SQL",
      unreachableWhen: {
        fieldsEmpty: ["publiclyAccessible"],
        title: "Cluster is not publicly accessible.",
        suggestions: [
          "Run queries from within the same VPC, e.g. via a bastion host or SSH tunnel.",
          "Toggle publicly accessible on the cluster (not recommended in production).",
          "Use the AWS Redshift Query Editor v2 from the AWS console.",
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "connection",
      displayName: "Redshift Connection",
      description: "Connection details for this Redshift cluster",
      entries: [
        { envKey: "REDSHIFT_HOST", outputKey: "endpoint" },
        { envKey: "REDSHIFT_PORT", outputKey: "port" },
        { envKey: "REDSHIFT_USER", outputKey: "masterUsername" },
      ],
    },
  ],
};
