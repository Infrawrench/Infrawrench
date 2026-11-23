import { f, o, rt } from "@infrawrench/plugin-base";

export const D1DatabaseResourceType = rt({
  name: "D1 Database",
  id: "d1-database",
  description: "A Cloudflare D1 SQLite database at the edge",
  fields: [
    f("name", "Name"),
    f("version", "Version", { showcase: true, required: false }),
    f("numTables", "Tables", { kind: "number", required: false }),
    // `file_size` (bytes) on GET /accounts/{id}/d1/database. One database
    // stops taking writes at 10 GB on Workers Paid (500 MB on Free); the
    // plugin cannot see the plan, so the ceiling is the paid one
    // (https://developers.cloudflare.com/d1/platform/limits/, read 2026-11-23).
    f("fileSize", "File Size", {
      required: false,
      usage: { limit: { constant: 10 * 1000 ** 3 }, unit: "bytes", label: "Database Size" },
    }),
    f("createdAt", "Created", { showcase: true, required: false }),
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
