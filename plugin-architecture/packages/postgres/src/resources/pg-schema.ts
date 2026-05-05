import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PostgresSchemaResourceType: ResourceTypeDefinition = {
  id: "pg-schema",
  displayName: "Schema",
  pluralDisplayName: "Schemas",
  description: "A PostgreSQL schema within a database",
  fields: [{ key: "name", label: "Schema Name", kind: "string", required: true }],
  outputs: [{ key: "tableCount", label: "Table Count", sensitive: false }],
  parentTypeId: "pg-database",
  dashboardPinnable: false,
};
