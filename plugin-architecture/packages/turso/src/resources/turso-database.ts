import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const TursoDatabaseResourceType: ResourceTypeDefinition = {
  id: "turso-database",
  displayName: "Database",
  pluralDisplayName: "Databases",
  description: "A Turso SQLite database — edge-replicated via libsql",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "group", label: "Group", kind: "string", required: false },
    { key: "primaryRegion", label: "Primary Region", kind: "string", required: false },
    { key: "regions", label: "Regions", kind: "string", required: false },
    { key: "version", label: "Version", kind: "string", required: false },
    { key: "isSchema", label: "Schema Database", kind: "boolean", required: false },
    { key: "schema", label: "Parent Schema", kind: "string", required: false },
    { key: "sleeping", label: "Sleeping", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "hostname", label: "Hostname", sensitive: false },
    { key: "connectionString", label: "Connection String (libsql)", sensitive: true },
    { key: "dbName", label: "Database Name", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "turso",
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "TURSO_DATABASE_URL for libsql client connections",
      entries: [{ envKey: "TURSO_DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
  resourceSqlDriver: {
    driver: "libsql",
    connectionStringOutputKey: "connectionString",
  },
};
