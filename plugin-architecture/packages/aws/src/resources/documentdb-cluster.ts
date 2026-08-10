import { f, o, rt } from "@infrawrench/plugin-base";

export const DocumentDBClusterResourceType = rt({
  name: "DocumentDB Cluster",
  id: "documentdb-cluster",
  description: "An Amazon DocumentDB MongoDB-compatible database cluster",
  fields: [
    f("clusterIdentifier", "Cluster ID"),
    f("engine", "Engine"),
    f("engineVersion", "Engine Version", { required: false }),
    f("status", "Status"),
    f("storageEncrypted", "Encrypted", { kind: "boolean", required: false }),
    f("multiAZ", "Multi-AZ", { kind: "boolean", required: false }),
    f("dbClusterMembers", "Members", { kind: "number", required: false }),
    f("dbClusterMemberIds", "Member Instances", {
      required: false,
      description: "Comma-separated DB instance identifiers in this cluster",
    }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      description: "Comma-separated VPC security group IDs attached to the cluster",
    }),
    f("dbSubnetGroupName", "DB Subnet Group", {
      required: false,
      description: "Name of the DB subnet group holding the cluster's VPC and subnets",
    }),
  ],
  outputs: [
    o("endpoint", "Writer Endpoint"),
    o("readerEndpoint", "Reader Endpoint"),
    o("port", "Port"),
    o("masterUsername", "Master Username"),
    o("clusterArn", "Cluster ARN"),
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "MongoDB connection URI for DocumentDB (constructed from endpoint + port)",
    }),
  ],
  // DocumentDB instances come back from the shared RDS DescribeDBInstances
  // call, so cluster members resolve to `rds-instance` resources.
  dependsOn: [
    { fieldKey: "dbClusterMemberIds", targetTypeId: "rds-instance", label: "has member" },
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
    {
      fieldKey: "dbSubnetGroupName",
      targetTypeId: "db-subnet-group",
      label: "placed in",
    },
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsMetrics: true,
  peerIntegrations: [
    {
      pluginId: "mongodb",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MongoDB",
      unreachableWhen: {
        fieldsEmpty: ["endpoint"],
        title: "Cluster endpoint is not reachable from this host.",
        suggestions: [
          "DocumentDB clusters are VPC-only — connect from inside the VPC or via an SSH tunnel.",
          "Use AWS Cloud9 / EC2 bastion in the same VPC.",
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "documentdb-connection",
      displayName: "DocumentDB Connection",
      description: "Connection details for this DocumentDB cluster",
      entries: [
        { envKey: "DOCDB_HOST", outputKey: "endpoint" },
        { envKey: "DOCDB_READER_HOST", outputKey: "readerEndpoint" },
        { envKey: "DOCDB_PORT", outputKey: "port" },
        { envKey: "DOCDB_USER", outputKey: "masterUsername" },
      ],
    },
    {
      id: "mongodb-uri",
      displayName: "MongoDB URI",
      description: "MONGODB_URI connection string for DocumentDB (MongoDB-compatible)",
      entries: [
        {
          envKey: "MONGODB_URI",
          outputKey: "connectionString",
          description: "MongoDB connection URI",
        },
      ],
    },
  ],
  postureChecks: [
    {
      id: "documentdb-cluster-unencrypted",
      title: "Storage not encrypted",
      severity: "medium",
      category: "encryption",
      conditions: [{ fieldKey: "storageEncrypted", when: "falsy" }],
      reason:
        "The cluster's storage is not encrypted at rest; enabling encryption later requires restoring into a new encrypted cluster.",
    },
  ],
});
