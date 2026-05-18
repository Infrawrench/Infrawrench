import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const D1DatabaseResourceType: ResourceTypeDefinition = {
  id: "d1-database",
  displayName: "D1 Database",
  pluralDisplayName: "D1 Databases",
  description: "A Cloudflare D1 SQLite database at the edge",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "version", label: "Version", kind: "string", required: false },
    { key: "numTables", label: "Tables", kind: "number", required: false },
    { key: "fileSize", label: "File Size", kind: "string", required: false },
    { key: "createdAt", label: "Created", kind: "string", required: false },
  ],
  outputs: [{ key: "databaseId", label: "Database ID", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  resourceSqlDriver: {
    driver: "d1",
    connectionStringOutputKey: "databaseId",
  },
  iconKey: "database",
  secretExportTemplates: [
    {
      id: "d1-binding",
      displayName: "D1 Binding",
      description: "Database ID for wrangler bindings (`[[d1_databases]]` in wrangler.toml).",
      entries: [{ envKey: "D1_DATABASE_ID", outputKey: "databaseId" }],
    },
  ],
};
