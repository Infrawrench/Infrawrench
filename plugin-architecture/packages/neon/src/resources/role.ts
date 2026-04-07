import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NeonRoleResourceType: ResourceTypeDefinition = {
  id: "neon-role",
  displayName: "Role",
  pluralDisplayName: "Roles",
  description: "A PostgreSQL role within a Neon branch",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "projectId", label: "Project ID", kind: "string", required: true },
    { key: "branchId", label: "Branch ID", kind: "string", required: true },
    { key: "protected", label: "Protected", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "password", label: "Password", sensitive: true },
  ],
  parentTypeId: "neon-branch",
  dashboardPinnable: false,
  iconKey: "neon",
};
