import { f, o, rt } from "@infrawrench/plugin-base";

export const NeonBranchResourceType = rt({
  name: "Branch",
  plural: "Branches",
  id: "neon-branch",
  description: "A Neon branch — an isolated copy-on-write fork of your database",
  fields: [
    f("name", "Name"),
    f("projectId", "Project ID"),
    f("primary", "Primary", { kind: "boolean", required: false }),
    f("currentState", "State", { required: false }),
    f("createdAt", "Created At", { required: false }),
  ],
  outputs: [
    o("branchId", "Branch ID"),
    o("projectId", "Project ID"),
    o("connectionString", "Connection String (default database)", { sensitive: true }),
  ],
  dependsOn: [{ fieldKey: "projectId", targetTypeId: "neon-project", label: "in project" }],
  // Neon's `history_retention_seconds` (the PITR window that is the real
  // automated protection here) is not synced by any lister, so there is no
  // retention field to declare — only the presence of a snapshot is judged.
  backupPolicy: { protectedBy: ["neon-snapshot"] },
  parentTypeId: "neon-project",
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
      description: "DATABASE_URL for the default database on this branch",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
});
