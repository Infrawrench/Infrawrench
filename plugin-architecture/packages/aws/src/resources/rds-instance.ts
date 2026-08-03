import { f, o, rt } from "@infrawrench/plugin-base";

export const RDSInstanceResourceType = rt({
  name: "RDS Instance",
  id: "rds-instance",
  description: "An Amazon RDS database instance",
  fields: [
    f("dbInstanceId", "DB Instance ID"),
    f("engine", "Engine", {
      kind: "enum",
      enumValues: [
        "mysql",
        "postgres",
        "mariadb",
        "oracle-ee",
        "oracle-se2",
        "sqlserver-ee",
        "sqlserver-se",
        "aurora-mysql",
        "aurora-postgresql",
      ],
    }),
    f("engineVersion", "Engine Version"),
    f("instanceClass", "Instance Class"),
    f("status", "Status"),
    f("allocatedStorage", "Storage (GB)", { kind: "number", required: false }),
    f("availabilityZone", "Availability Zone", { required: false }),
    f("multiAZ", "Multi-AZ", { kind: "boolean", required: false }),
    f("vpcId", "VPC ID", { required: false, description: "VPC of the instance's DB subnet group" }),
    f("subnetIds", "Subnets", {
      required: false,
      description: "Comma-separated subnet IDs from the DB subnet group",
    }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      description: "Comma-separated VPC security group IDs attached to the instance",
    }),
    f("dbClusterIdentifier", "Cluster ID", {
      required: false,
      description: "Aurora/DocumentDB/Neptune cluster this instance is a member of",
    }),
    f("network", "VPC Network", {
      kind: "association",
      required: false,
      description: "VPC network for the RDS instance",
      allowLiteral: true,
      resolvableOutputKeys: ["vpcId"],
      resolvableFrom: [
        {
          pluginId: "aws",
          resourceTypeId: "vpc",
          outputKey: "vpcId",
        },
      ],
    }),
  ],
  outputs: [
    o("endpoint", "Endpoint"),
    o("port", "Port"),
    o("masterUsername", "Master Username"),
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "Database connection URI (constructed from engine + endpoint + port)",
    }),
  ],
  // A cluster member reports the cluster id under `DBClusterIdentifier`, which
  // is exactly the external id of the Aurora / DocumentDB / Neptune cluster —
  // the same DescribeDBInstances call serves all three engines, so all three
  // are named here and only the matching one resolves.
  dependsOn: [
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
    { fieldKey: "subnetIds", targetTypeId: "subnet", label: "in subnet" },
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
    { fieldKey: "dbClusterIdentifier", targetTypeId: "rds-cluster", label: "member of" },
    { fieldKey: "dbClusterIdentifier", targetTypeId: "documentdb-cluster", label: "member of" },
    { fieldKey: "dbClusterIdentifier", targetTypeId: "neptune-cluster", label: "member of" },
  ],
  supportsMetrics: true,
  // Sleep/wake schedules: StartDBInstance / StopDBInstance. A stopped instance
  // stops instance-hour billing (storage and backups keep billing); note AWS
  // auto-starts a stopped RDS instance again after 7 days.
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "status",
    runningValues: ["available", "starting", "backing-up"],
    stoppedValues: ["stopped", "stopping"],
  },
  supportsCreate: true,
  iconKey: "database",
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "engine", prefix: "postgres" },
      unreachableWhen: {
        fieldsEmpty: ["endpoint"],
        title: "Instance endpoint is not reachable from this host.",
        suggestions: [
          "RDS instances are typically VPC-only — connect from inside the VPC or via an SSH tunnel.",
          "Enable publicly accessible on the instance (not recommended in production).",
          "Use an EC2 bastion in the same VPC.",
        ],
      },
    },
    {
      pluginId: "mysql",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MySQL",
      showWhen: { fieldKey: "engine", equals: "mysql" },
      unreachableWhen: {
        fieldsEmpty: ["endpoint"],
        title: "Instance endpoint is not reachable from this host.",
        suggestions: [
          "RDS instances are typically VPC-only — connect from inside the VPC or via an SSH tunnel.",
          "Enable publicly accessible on the instance (not recommended in production).",
          "Use an EC2 bastion in the same VPC.",
        ],
      },
    },
    {
      pluginId: "mysql",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MariaDB",
      showWhen: { fieldKey: "engine", equals: "mariadb" },
      unreachableWhen: {
        fieldsEmpty: ["endpoint"],
        title: "Instance endpoint is not reachable from this host.",
        suggestions: [
          "RDS instances are typically VPC-only — connect from inside the VPC or via an SSH tunnel.",
          "Enable publicly accessible on the instance (not recommended in production).",
          "Use an EC2 bastion in the same VPC.",
        ],
      },
    },
    {
      pluginId: "mssql",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "SQL Server",
      showWhen: { fieldKey: "engine", prefix: "sqlserver" },
      unreachableWhen: {
        fieldsEmpty: ["endpoint"],
        title: "Instance endpoint is not reachable from this host.",
        suggestions: [
          "RDS instances are typically VPC-only — connect from inside the VPC or via an SSH tunnel.",
          "Enable publicly accessible on the instance (not recommended in production).",
          "Use an EC2 bastion in the same VPC.",
        ],
      },
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "Database endpoint for connecting",
      entries: [
        { envKey: "DATABASE_URL", outputKey: "connectionString" },
        { envKey: "DB_HOST", outputKey: "endpoint" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "masterUsername" },
      ],
    },
  ],
});
