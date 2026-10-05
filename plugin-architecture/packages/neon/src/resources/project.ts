import { f, o, rt } from "@infrawrench/plugin-base";

export const NeonProjectResourceType = rt({
  name: "Project",
  id: "neon-project",
  description: "A Neon project, containing branches, endpoints and databases",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false, editable: false }),
    f("pgVersion", "PostgreSQL Version", { required: false, editable: false }),
    f("orgId", "Organization", { required: false, editable: false }),
    f("proxyHost", "Proxy Host", { required: false, editable: false }),
    f("computeLastActiveAt", "Compute Last Active", { required: false, editable: false }),
    f("historyRetentionSeconds", "Restore Window (s)", {
      kind: "number",
      required: false,
      description:
        "How far back branches can be restored, in seconds (0 to 2592000). Plan limits: Free 6 h, Launch 7 days, Scale 30 days.",
    }),
    f("createdAt", "Created At", { required: false, editable: false }),
  ],
  outputs: [
    o("projectId", "Project ID"),
    o("region", "Region"),
    o("pgVersion", "PostgreSQL Version"),
    o("connectionString", "Connection String (default database)", { sensitive: true }),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "neon",
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "DATABASE_URL for the default database on the primary branch",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
});
