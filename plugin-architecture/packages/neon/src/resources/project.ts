import { f, o, rt } from "@infrawrench/plugin-base";

export const NeonProjectResourceType = rt({
  name: "Project",
  id: "neon-project",
  description: "A Neon project — contains branches, endpoints, and databases",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false }),
    f("pgVersion", "PostgreSQL Version", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [
    o("projectId", "Project ID"),
    o("region", "Region"),
    o("pgVersion", "PostgreSQL Version"),
    o("connectionString", "Connection String (default database)", { sensitive: true }),
  ],
  supportsCreate: true,
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
