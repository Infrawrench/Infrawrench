import { f, o, rt } from "@infrawrench/plugin-base";

export const TableResourceType = rt({
  name: "Table",
  pinnable: false,
  id: "databricks-table",
  description: "A Unity Catalog table (managed, external, or view)",
  fields: [
    f("name", "Name"),
    f("catalogName", "Catalog"),
    f("schemaName", "Schema"),
    f("tableType", "Table Type", {
      kind: "enum",
      enumValues: ["MANAGED", "EXTERNAL", "VIEW", "MATERIALIZED_VIEW", "STREAMING_TABLE"],
    }),
    f("dataSourceFormat", "Format", { required: false }),
    f("owner", "Owner", { required: false }),
    f("comment", "Comment", { required: false }),
    f("storageLocation", "Storage Location", { required: false }),
    f("columnCount", "Columns", { kind: "number", required: false }),
  ],
  outputs: [o("fullName", "Full Name"), o("storageLocation", "Storage Location")],
  // `schemaName` is the bare schema name while a schema's external id is
  // `catalog.schema` — the template composes the qualified name, which stays
  // exact where a bare `default` would hit every catalog's.
  dependsOn: [
    { fieldKey: "catalogName", targetTypeId: "databricks-catalog", label: "in catalog" },
    {
      fieldKey: "schemaName",
      targetTypeId: "databricks-schema",
      matchTemplate: "{catalogName}.{schemaName}",
      label: "in schema",
    },
  ],
  parentTypeId: "databricks-schema",
  supportsCreate: true,
});
