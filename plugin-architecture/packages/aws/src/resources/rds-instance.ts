import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const RDSInstanceResourceType: ResourceTypeDefinition = {
  id: "rds-instance",
  displayName: "RDS Instance",
  pluralDisplayName: "RDS Instances",
  description: "An Amazon RDS database instance",
  fields: [
    { key: "dbInstanceId", label: "DB Instance ID", kind: "string", required: true },
    {
      key: "engine",
      label: "Engine",
      kind: "enum",
      required: true,
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
    },
    { key: "engineVersion", label: "Engine Version", kind: "string", required: true },
    { key: "instanceClass", label: "Instance Class", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: true },
    { key: "allocatedStorage", label: "Storage (GB)", kind: "number", required: false },
    { key: "availabilityZone", label: "Availability Zone", kind: "string", required: false },
    { key: "multiAZ", label: "Multi-AZ", kind: "boolean", required: false },
    {
      key: "network",
      label: "VPC Network",
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
    },
  ],
  outputs: [
    { key: "endpoint", label: "Endpoint", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    { key: "masterUsername", label: "Master Username", sensitive: false },
    {
      key: "connectionString",
      label: "Connection String",
      sensitive: true,
      description: "Database connection URI (constructed from engine + endpoint + port)",
    },
  ],
  dashboardPinnable: true,
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
};
