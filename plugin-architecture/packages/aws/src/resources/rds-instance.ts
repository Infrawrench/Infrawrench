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
  ],
  outputs: [
    { key: "endpoint", label: "Endpoint", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    { key: "masterUsername", label: "Master Username", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsMetrics: true,
  iconKey: "database",
  resourceSqlDriver: {
    driver: "postgres",
    connectionStringOutputKey: "endpoint",
  },
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "Database endpoint for connecting",
      entries: [
        { envKey: "DB_HOST", outputKey: "endpoint" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "masterUsername" },
      ],
    },
  ],
};
