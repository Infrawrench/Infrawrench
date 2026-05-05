import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SchemaResourceType: ResourceTypeDefinition = {
  id: "databricks-schema",
  displayName: "Schema",
  pluralDisplayName: "Schemas",
  description: "A Unity Catalog schema (namespace for tables within a catalog)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "catalogName", label: "Catalog", kind: "string", required: true },
    { key: "owner", label: "Owner", kind: "string", required: false },
    { key: "comment", label: "Comment", kind: "string", required: false },
    { key: "tableCount", label: "Tables", kind: "number", required: false },
  ],
  outputs: [{ key: "fullName", label: "Full Name", sensitive: false }],
  parentTypeId: "databricks-catalog",
  dashboardPinnable: false,
  supportsCreate: true,
};
