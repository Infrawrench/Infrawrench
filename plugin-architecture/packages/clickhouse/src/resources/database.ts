import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DatabaseResourceType: ResourceTypeDefinition = {
  id: "ch-database",
  displayName: "Database",
  pluralDisplayName: "Databases",
  description: "A database within a ClickHouse Cloud service",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "engine", label: "Engine", kind: "string", required: false },
    { key: "comment", label: "Comment", kind: "string", required: false },
  ],
  outputs: [{ key: "databaseName", label: "Database Name", sensitive: false }],
  dashboardPinnable: false,
  iconKey: "database",
  parentTypeId: "ch-service",
};
