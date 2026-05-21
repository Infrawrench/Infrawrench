import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NeonDatabaseResourceType: ResourceTypeDefinition = {
  id: "neon-database",
  displayName: "Database",
  pluralDisplayName: "Databases",
  description: "A PostgreSQL database within a Neon branch",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "projectId", label: "Project ID", kind: "string", required: true },
    { key: "branchId", label: "Branch ID", kind: "string", required: true },
    { key: "ownerName", label: "Owner", kind: "string", required: false },
  ],
  outputs: [
    { key: "connectionString", label: "Connection String", sensitive: true },
    { key: "host", label: "Host", sensitive: false },
    { key: "database", label: "Database Name", sensitive: false },
  ],
  parentTypeId: "neon-branch",
  dashboardPinnable: true,
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
};
