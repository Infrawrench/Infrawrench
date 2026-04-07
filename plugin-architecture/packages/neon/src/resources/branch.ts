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
  ],
  parentTypeId: "neon-project",
  dashboardPinnable: false,
  supportsCreate: true,
  iconKey: "neon",
};
