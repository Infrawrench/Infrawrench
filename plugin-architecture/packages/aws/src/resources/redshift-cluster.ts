import { f, o, rt } from "@infrawrench/plugin-base";

export const RedshiftClusterResourceType = rt({
  name: "Redshift Cluster",
  id: "redshift-cluster",
  description: "An Amazon Redshift data warehouse cluster",
  fields: [
    f("clusterIdentifier", "Cluster ID"),
    f("nodeType", "Node Type"),
    f("status", "Status"),
    f("numberOfNodes", "Nodes", { kind: "number" }),
    f("dbName", "Database Name", { required: false }),
    f("availabilityZone", "Availability Zone", { required: false }),
    f("encrypted", "Encrypted", { kind: "boolean", required: false }),
    f("publiclyAccessible", "Publicly Accessible", { kind: "boolean", required: false }),
    f("vpcId", "VPC ID", { required: false }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      description: "Comma-separated VPC security group IDs attached to the cluster",
    }),
  ],
  outputs: [
    o("endpoint", "Endpoint"),
    o("port", "Port"),
    o("masterUsername", "Master Username"),
    o("clusterArn", "Cluster ARN"),
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "PostgreSQL connection URI for Redshift (constructed from endpoint + port)",
    }),
  ],
  dependsOn: [
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsMetrics: true,
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
  postureChecks: [
    {
      id: "redshift-publicly-accessible",
      title: "Cluster publicly accessible",
      severity: "critical",
      category: "public-exposure",
      conditions: [{ fieldKey: "publiclyAccessible", when: "truthy" }],
      reason:
        "The cluster endpoint resolves to a public IP reachable from outside the VPC — the data warehouse is one leaked credential away from the internet.",
    },
    {
      id: "redshift-unencrypted",
      title: "Cluster not encrypted",
      severity: "medium",
      category: "encryption",
      conditions: [{ fieldKey: "encrypted", when: "falsy" }],
      reason: "The cluster's data is not encrypted at rest.",
    },
  ],
});
