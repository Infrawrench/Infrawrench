import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NeonDataApiResourceType: ResourceTypeDefinition = {
  id: "neon-data-api",
  displayName: "Data API",
  pluralDisplayName: "Data APIs",
  description: "A Neon Data API endpoint exposing a branch database over REST",
  fields: [
    { key: "url", label: "URL", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "projectId", label: "Project ID", kind: "string", required: true },
    { key: "branchId", label: "Branch ID", kind: "string", required: true },
    { key: "database", label: "Database", kind: "string", required: true },
    { key: "schemas", label: "Schemas", kind: "string", required: false },
    { key: "anonymousRole", label: "Anonymous Role", kind: "string", required: false },
  ],
  outputs: [{ key: "url", label: "URL", sensitive: false }],
  parentTypeId: "neon-database",
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "neon",
};
