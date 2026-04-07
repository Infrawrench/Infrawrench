import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NeonProjectResourceType: ResourceTypeDefinition = {
  id: "neon-project",
  displayName: "Project",
  pluralDisplayName: "Projects",
  description: "A Neon project — contains branches, endpoints, and databases",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "pgVersion", label: "PostgreSQL Version", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
  ],
  outputs: [
    { key: "projectId", label: "Project ID", sensitive: false },
    { key: "region", label: "Region", sensitive: false },
    { key: "pgVersion", label: "PostgreSQL Version", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "neon",
};
