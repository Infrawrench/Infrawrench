import { f, o, rt } from "@infrawrench/plugin-base";

export const NetlifyDatabaseResourceType = rt({
  name: "Database",
  id: "netlify-database",
  description:
    "Netlify DB: a serverless Postgres database attached to a site, with a branch per deploy context",
  parentTypeId: "netlify-site",
  fields: [
    f("siteName", "Site"),
    f("siteId", "Site ID", { required: false }),
    f("state", "State", {
      required: false,
      description: "State of the production branch",
    }),
    f("branchCount", "Branches", { kind: "number", required: false }),
    f("sizeBytes", "Size (bytes)", {
      kind: "number",
      required: false,
      description: "Logical size of the production branch",
    }),
    f("computeState", "Compute", { required: false, description: "active or idle" }),
    f("minCu", "Min Compute Units", { kind: "number", required: false }),
    f("maxCu", "Max Compute Units", { kind: "number", required: false }),
    f("suspendTimeoutSeconds", "Suspend After (s)", { kind: "number", required: false }),
    f("lastActiveAt", "Last Active", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "Postgres URL for the production branch",
    }),
  ],
  dependsOn: [{ fieldKey: "siteId", targetTypeId: "netlify-site", label: "database of" }],
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
    },
  ],
  secretExportTemplates: [
    {
      id: "netlify-db-url",
      displayName: "Database URL",
      description: "DATABASE_URL for the site's production database branch",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
  supportsCreate: true,
  iconKey: "database",
});
