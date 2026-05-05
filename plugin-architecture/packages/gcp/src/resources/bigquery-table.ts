import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const BigQueryTableResourceType: ResourceTypeDefinition = {
  id: "bigquery-table",
  displayName: "BigQuery Table",
  pluralDisplayName: "Tables",
  description: "A table, view, or materialized view inside a BigQuery dataset",
  fields: [
    { key: "name", label: "Table ID", kind: "string", required: true },
    { key: "friendlyName", label: "Friendly Name", kind: "string", required: false },
    { key: "type", label: "Type", kind: "string", required: false },
    { key: "location", label: "Data location", kind: "string", required: false },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "labels", label: "Labels", kind: "string", required: false },

    // Timestamps (rendered as formatted strings)
    { key: "creationTime", label: "Created", kind: "string", required: false },
    { key: "lastModifiedTime", label: "Last modified", kind: "string", required: false },
    { key: "expirationTime", label: "Table expiration", kind: "string", required: false },

    // Schema / partitioning / clustering
    { key: "primaryKeys", label: "Primary key(s)", kind: "string", required: false },
    { key: "partitioning", label: "Partitioning", kind: "string", required: false },
    { key: "clusteringFields", label: "Clustering", kind: "string", required: false },

    // Dataset-inherited config
    { key: "defaultCollation", label: "Default collation", kind: "string", required: false },
    { key: "defaultRoundingMode", label: "Default rounding mode", kind: "string", required: false },
    { key: "caseInsensitive", label: "Case insensitive", kind: "boolean", required: false },

    // Storage info (populated from `GET table`)
    { key: "numRows", label: "Number of rows", kind: "string", required: false },
    { key: "numBytes", label: "Total logical bytes", kind: "string", required: false },
    {
      key: "numActiveLogicalBytes",
      label: "Active logical bytes",
      kind: "string",
      required: false,
    },
    {
      key: "numLongTermLogicalBytes",
      label: "Long term logical bytes",
      kind: "string",
      required: false,
    },
    {
      key: "numCurrentPhysicalBytes",
      label: "Current physical bytes",
      kind: "string",
      required: false,
    },
    {
      key: "numTotalPhysicalBytes",
      label: "Total physical bytes",
      kind: "string",
      required: false,
    },
    {
      key: "numActivePhysicalBytes",
      label: "Active physical bytes",
      kind: "string",
      required: false,
    },
    {
      key: "numLongTermPhysicalBytes",
      label: "Long term physical bytes",
      kind: "string",
      required: false,
    },
    {
      key: "numTimeTravelPhysicalBytes",
      label: "Time travel physical bytes",
      kind: "string",
      required: false,
    },
  ],
  outputs: [],
  parentTypeId: "bigquery-dataset",
  dashboardPinnable: true,
  supportsCreate: true,
};
