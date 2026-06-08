import { f, o, rt } from "@infrawrench/plugin-base";

export const D1DatabaseResourceType = rt({
  name: "D1 Database",
  id: "d1-database",
  description: "A Cloudflare D1 SQLite database at the edge",
  fields: [
    f("name", "Name"),
    f("version", "Version", { required: false }),
    f("numTables", "Tables", { kind: "number", required: false }),
    f("fileSize", "File Size", { required: false }),
    f("createdAt", "Created", { required: false }),
  ],
  outputs: [o("databaseId", "Database ID")],
  supportsCreate: true,
  supportsMetrics: true,
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
});
