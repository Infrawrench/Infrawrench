import { f, o, rt } from "@infrawrench/plugin-base";

export const NeptuneClusterResourceType = rt({
  name: "Neptune Cluster",
  id: "neptune-cluster",
  description: "An Amazon Neptune graph database cluster",
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
  ],
  outputs: [
    o("endpoint", "Writer Endpoint"),
    o("readerEndpoint", "Reader Endpoint"),
    o("port", "Port"),
    o("clusterArn", "Cluster ARN"),
  ],
  // Neptune instances come back from the shared RDS DescribeDBInstances call,
  // so cluster members resolve to `rds-instance` resources.
  dependsOn: [
    { fieldKey: "dbClusterMemberIds", targetTypeId: "rds-instance", label: "has member" },
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsMetrics: true,
  secretExportTemplates: [
    {
      id: "neptune-connection",
      displayName: "Neptune Connection",
      description: "Connection details for this Neptune cluster",
      entries: [
        { envKey: "NEPTUNE_ENDPOINT", outputKey: "endpoint" },
        { envKey: "NEPTUNE_READER_ENDPOINT", outputKey: "readerEndpoint" },
        { envKey: "NEPTUNE_PORT", outputKey: "port" },
      ],
    },
  ],
});
