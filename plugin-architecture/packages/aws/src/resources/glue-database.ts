import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const GlueDatabaseResourceType: ResourceTypeDefinition = {
  id: "glue-database",
  displayName: "Glue Database",
  pluralDisplayName: "Glue Databases",
  description: "An AWS Glue Data Catalog database",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "locationUri", label: "Location URI", kind: "string", required: false },
    { key: "createTime", label: "Created", kind: "string", required: false },
    { key: "catalogId", label: "Catalog ID", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
  iconKey: "database",
  supportsCreate: true,
};
