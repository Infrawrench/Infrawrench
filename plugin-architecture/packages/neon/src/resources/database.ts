import { f, o, rt } from "@infrawrench/plugin-base";

export const NeonDatabaseResourceType = rt({
  name: "Database",
  id: "neon-database",
  description: "A PostgreSQL database within a Neon branch",
  fields: [
    f("name", "Name"),
    f("projectId", "Project ID"),
    f("branchId", "Branch ID"),
    f("ownerName", "Owner", { required: false }),
  ],
  outputs: [
    o("connectionString", "Connection String", { sensitive: true }),
    o("host", "Host"),
    o("database", "Database Name"),
  ],
  dependsOn: [
    { fieldKey: "projectId", targetTypeId: "neon-project", label: "in project" },
    { fieldKey: "branchId", targetTypeId: "neon-branch", label: "on branch" },
    // Roles are keyed by name within a branch, which is also their external id.
    { fieldKey: "ownerName", targetTypeId: "neon-role", label: "owned by" },
  ],
  parentTypeId: "neon-branch",
  supportsCreate: true,
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
      description: "Single DATABASE_URL containing the full Neon connection string",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
});
