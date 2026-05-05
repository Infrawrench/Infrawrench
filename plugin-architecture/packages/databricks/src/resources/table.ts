import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const TableResourceType: ResourceTypeDefinition = {
  id: "databricks-table",
  displayName: "Table",
  pluralDisplayName: "Tables",
  description: "A Unity Catalog table (managed, external, or view)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "catalogName", label: "Catalog", kind: "string", required: true },
    { key: "schemaName", label: "Schema", kind: "string", required: true },
    {
      key: "tableType",
      label: "Table Type",
      kind: "enum",
      required: true,
      enumValues: ["MANAGED", "EXTERNAL", "VIEW", "MATERIALIZED_VIEW", "STREAMING_TABLE"],
    },
    { key: "dataSourceFormat", label: "Format", kind: "string", required: false },
    { key: "owner", label: "Owner", kind: "string", required: false },
    { key: "comment", label: "Comment", kind: "string", required: false },
    { key: "storageLocation", label: "Storage Location", kind: "string", required: false },
    { key: "columnCount", label: "Columns", kind: "number", required: false },
  ],
  outputs: [
    { key: "fullName", label: "Full Name", sensitive: false },
    { key: "storageLocation", label: "Storage Location", sensitive: false },
  ],
  parentTypeId: "databricks-schema",
  supportsCreate: true,
  dashboardPinnable: false,
};
