import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NeonBranchResourceType: ResourceTypeDefinition = {
  id: "neon-branch",
  displayName: "Branch",
  pluralDisplayName: "Branches",
  description: "A Neon branch — an isolated copy-on-write fork of your database",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "projectId", label: "Project ID", kind: "string", required: true },
    { key: "primary", label: "Primary", kind: "boolean", required: false },
    { key: "currentState", label: "State", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
  ],
  outputs: [
    { key: "branchId", label: "Branch ID", sensitive: false },
    { key: "projectId", label: "Project ID", sensitive: false },
    { key: "connectionString", label: "Connection String (default database)", sensitive: true },
  ],
  parentTypeId: "neon-project",
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "neon",
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "DATABASE_URL for the default database on this branch",
      entries: [
        { envKey: "DATABASE_URL", outputKey: "connectionString" },
      ],
    },
  ],
};
