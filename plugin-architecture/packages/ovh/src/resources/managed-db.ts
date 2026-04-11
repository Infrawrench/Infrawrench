import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ManagedDbResourceType: ResourceTypeDefinition = {
  id: "managed-db",
  displayName: "Managed Database",
  pluralDisplayName: "Managed Databases",
  description: "An OVHcloud Public Cloud managed database service",
  fields: [
    { key: "description", label: "Name", kind: "string", required: true },
    {
      key: "engine",
      label: "Engine",
      kind: "enum",
      required: true,
      enumValues: [
        "postgresql",
        "mysql",
        "mongodb",
        "redis",
        "kafka",
        "opensearch",
        "cassandra",
        "m3db",
        "grafana",
      ],
    },
    {
      key: "version",
      label: "Version",
      kind: "string",
      required: true,
      description: "Engine version, e.g. 16 for PostgreSQL 16",
    },
    {
      key: "plan",
      label: "Plan",
      kind: "string",
      required: true,
      description: "Service plan, e.g. essential, business, enterprise",
    },
    {
      key: "region",
      label: "Region",
      kind: "string",
      required: true,
    },
    {
      key: "flavor",
      label: "Flavor",
      kind: "string",
      required: true,
      description: "Node flavor, e.g. db1-7",
    },
    {
      key: "nodeCount",
      label: "Node Count",
      kind: "number",
      required: true,
    },
    {
      key: "status",
      label: "Status",
      kind: "string",
      required: false,
    },
  ],
  outputs: [
    {
      key: "connectionString",
      label: "Connection String",
      sensitive: true,
      description: "Full connection URI",
    },
    { key: "host", label: "Host", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    { key: "username", label: "Username", sensitive: false },
    { key: "password", label: "Password", sensitive: true },
    { key: "database", label: "Database Name", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "database",
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
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
      id: "individual",
      displayName: "Individual Credentials",
      description: "Separate environment variables for host, port, user, password, and database",
      entries: [
        { envKey: "DB_HOST", outputKey: "host" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
        { envKey: "DB_NAME", outputKey: "database" },
      ],
    },
  ],
};
