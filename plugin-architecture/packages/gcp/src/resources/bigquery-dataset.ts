import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const BigQueryDatasetResourceType: ResourceTypeDefinition = {
  id: "bigquery-dataset",
  displayName: "BigQuery Dataset",
  pluralDisplayName: "BigQuery Datasets",
  description: "A Google BigQuery dataset",
  fields: [
    { key: "name", label: "Dataset ID", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "defaultTableExpirationMs", label: "Table Expiration (ms)", kind: "number", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
};
