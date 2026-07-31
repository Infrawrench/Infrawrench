import { f, rt } from "@infrawrench/plugin-base";

export const BigQueryTableResourceType = rt({
  name: "BigQuery Table",
  plural: "Tables",
  id: "bigquery-table",
  description: "A table, view, or materialized view inside a BigQuery dataset",
  fields: [
    f("name", "Table ID"),
    f("datasetId", "Dataset", {
      required: false,
      description: "Fully-qualified dataset this table lives in, as project:dataset",
    }),
    f("friendlyName", "Friendly Name", { required: false }),
    f("type", "Type", { required: false }),
    f("location", "Data location", { required: false }),
    f("description", "Description", { required: false }),
    f("labels", "Labels", { required: false }),
    f("creationTime", "Created", { required: false }),
    f("lastModifiedTime", "Last modified", { required: false }),
    f("expirationTime", "Table expiration", { required: false }),
    f("primaryKeys", "Primary key(s)", { required: false }),
    f("partitioning", "Partitioning", { required: false }),
    f("clusteringFields", "Clustering", { required: false }),
    f("defaultCollation", "Default collation", { required: false }),
    f("defaultRoundingMode", "Default rounding mode", { required: false }),
    f("caseInsensitive", "Case insensitive", { kind: "boolean", required: false }),
    f("numRows", "Number of rows", { required: false }),
    f("numBytes", "Total logical bytes", { required: false }),
    f("numActiveLogicalBytes", "Active logical bytes", { required: false }),
    f("numLongTermLogicalBytes", "Long term logical bytes", { required: false }),
    f("numCurrentPhysicalBytes", "Current physical bytes", { required: false }),
    f("numTotalPhysicalBytes", "Total physical bytes", { required: false }),
    f("numActivePhysicalBytes", "Active physical bytes", { required: false }),
    f("numLongTermPhysicalBytes", "Long term physical bytes", { required: false }),
    f("numTimeTravelPhysicalBytes", "Time travel physical bytes", { required: false }),
  ],
  outputs: [],
  // A dataset's external id is `project:dataset`, which is exactly what the
  // lister stores — a bare dataset id is only unique inside its project.
  dependsOn: [{ fieldKey: "datasetId", targetTypeId: "bigquery-dataset", label: "in dataset" }],
  parentTypeId: "bigquery-dataset",
  supportsCreate: true,
});
