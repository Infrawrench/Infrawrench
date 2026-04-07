import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const ManagedDatabaseResourceType: ResourceTypeDefinition = {
  id: "rdb-instance",
  displayName: "Managed Database",
  pluralDisplayName: "Managed Databases",
  description: "A Scaleway Managed Database (RDB) instance",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "engine",
      label: "Engine",
      kind: "enum",
      required: true,
      enumValues: ["PostgreSQL", "MySQL", "Redis"],
    },
    {
      key: "engineVersion",
      label: "Engine Version",
      kind: "string",
      required: true,
    },
    {
      key: "region",
      label: "Region",
      kind: "enum",
      required: true,
      enumValues: ["fr-par", "nl-ams", "pl-waw"],
    },
    {
      key: "nodeType",
      label: "Node Type",
      kind: "string",
      required: true,
      description: "Instance node type, e.g. DB-DEV-S, DB-GP-XS",
    },
    {
      key: "status",
      label: "Status",
      kind: "string",
      required: false,
    },
  ],
  outputs: [
    { key: "host", label: "Host", sensitive: false },
    { key: "port", label: "Port", sensitive: false },
    { key: "username", label: "Username", sensitive: false },
    { key: "password", label: "Password", sensitive: true },
    { key: "dbName", label: "Database Name", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "database",
  secretExportTemplates: [
    {
      id: "individual",
      displayName: "Individual Credentials",
      description: "Separate environment variables for host, port, user, password, and database",
      entries: [
        { envKey: "DB_HOST", outputKey: "host" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
        { envKey: "DB_NAME", outputKey: "dbName" },
      ],
    },
  ],
};
