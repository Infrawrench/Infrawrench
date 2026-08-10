import { f, o, rt } from "@infrawrench/plugin-base";

export const TursoDatabaseResourceType = rt({
  name: "Database",
  id: "turso-database",
  description: "A Turso SQLite database — edge-replicated via libsql",
  fields: [
    f("name", "Name"),
    f("group", "Group", { required: false }),
    f("primaryRegion", "Primary Region", { required: false }),
    f("regions", "Regions", { required: false }),
    f("version", "Version", { required: false }),
    f("isSchema", "Schema Database", { kind: "boolean", required: false }),
    f("schema", "Parent Schema", { required: false }),
    f("sleeping", "Sleeping", { kind: "boolean", required: false }),
  ],
  outputs: [
    o("hostname", "Hostname"),
    o("connectionString", "Connection String (libsql)", { sensitive: true }),
    o("dbName", "Database Name"),
  ],
  dependsOn: [
    { fieldKey: "group", targetTypeId: "turso-group", label: "in group" },
    // Schema databases are named, so a child points at its parent by name.
    { fieldKey: "schema", targetTypeId: "turso-database", label: "extends schema" },
    { fieldKey: "primaryRegion", targetTypeId: "turso-location", label: "primary in" },
    // Comma-joined location codes — one edge per replica location.
    { fieldKey: "regions", targetTypeId: "turso-location", label: "replicated in" },
  ],
  supportsCreate: true,
  iconKey: "turso",
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "TURSO_DATABASE_URL for libsql client connections",
      entries: [
        { envKey: "TURSO_DATABASE_URL", outputKey: "connectionString" },
        { envKey: "TURSO_HOSTNAME", outputKey: "hostname" },
      ],
    },
  ],
  resourceSqlDriver: {
    driver: "libsql",
    connectionStringOutputKey: "connectionString",
  },
});
