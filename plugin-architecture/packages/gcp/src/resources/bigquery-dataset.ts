import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const BigQueryDatasetResourceType: ResourceTypeDefinition = {
  id: "bigquery-dataset",
  displayName: "BigQuery Dataset",
  pluralDisplayName: "BigQuery Datasets",
  description: "A Google BigQuery dataset",
  fields: [
    { key: "name", label: "Dataset ID", kind: "string", required: true },
    { key: "friendlyName", label: "Friendly Name", kind: "string", required: false },
    { key: "location", label: "Location", kind: "string", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
    {
      key: "defaultTableExpirationMs",
      label: "Default table expiration (ms)",
      kind: "number",
      required: false,
    },
    {
      key: "defaultPartitionExpirationMs",
      label: "Default partition expiration (ms)",
      kind: "number",
      required: false,
    },
    { key: "defaultCollation", label: "Default collation", kind: "string", required: false },
    { key: "defaultRoundingMode", label: "Default rounding mode", kind: "string", required: false },
    { key: "isCaseInsensitive", label: "Case insensitive", kind: "boolean", required: false },
    { key: "storageBillingModel", label: "Storage billing model", kind: "string", required: false },
    {
      key: "maxTimeTravelHours",
      label: "Max time travel (hours)",
      kind: "number",
      required: false,
    },
    { key: "labels", label: "Labels", kind: "string", required: false },
    { key: "creationTime", label: "Created", kind: "string", required: false },
    { key: "lastModifiedTime", label: "Last modified", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
};
