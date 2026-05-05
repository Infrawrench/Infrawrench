import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CatalogResourceType: ResourceTypeDefinition = {
  id: "databricks-catalog",
  displayName: "Catalog",
  pluralDisplayName: "Catalogs",
  description: "A Unity Catalog catalog (top-level namespace for schemas and tables)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "owner", label: "Owner", kind: "string", required: false },
    { key: "comment", label: "Comment", kind: "string", required: false },
    { key: "catalogType", label: "Type", kind: "string", required: false },
    { key: "isolationMode", label: "Isolation Mode", kind: "string", required: false },
    { key: "securable_kind", label: "Securable Kind", kind: "string", required: false },
    { key: "schemaCount", label: "Schemas", kind: "number", required: false },
  ],
  outputs: [
    { key: "catalogName", label: "Catalog Name", sensitive: false },
    { key: "metastoreId", label: "Metastore ID", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "catalog",
};
