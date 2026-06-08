import { f, o, rt } from "@infrawrench/plugin-base";

export const CatalogResourceType = rt({
  name: "Catalog",
  id: "databricks-catalog",
  description: "A Unity Catalog catalog (top-level namespace for schemas and tables)",
  fields: [
    f("name", "Name"),
    f("owner", "Owner", { required: false }),
    f("comment", "Comment", { required: false }),
    f("catalogType", "Type", { required: false }),
    f("isolationMode", "Isolation Mode", { required: false }),
    f("securable_kind", "Securable Kind", { required: false }),
    f("schemaCount", "Schemas", { kind: "number", required: false }),
  ],
  outputs: [o("catalogName", "Catalog Name"), o("metastoreId", "Metastore ID")],
  supportsCreate: true,
  iconKey: "catalog",
});
