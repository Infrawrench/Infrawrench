import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PsDatabaseResourceType: ResourceTypeDefinition = {
  id: "ps-database",
  displayName: "Database",
  pluralDisplayName: "Databases",
  description: "A PlanetScale MySQL-compatible serverless database",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "htmlUrl", label: "Dashboard URL", kind: "string", required: false },
    { key: "createdAt", label: "Created At", kind: "string", required: false },
    { key: "updatedAt", label: "Updated At", kind: "string", required: false },
  ],
  outputs: [
    { key: "databaseName", label: "Database Name", sensitive: false },
    { key: "region", label: "Region", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "planetscale",
};
