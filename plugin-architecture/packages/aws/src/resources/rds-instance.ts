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
  supportsMetrics: true,
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
