import { f, o, rt } from "@infrawrench/plugin-base";

export const BigQueryDatasetResourceType = rt({
  name: "BigQuery Dataset",
  id: "bigquery-dataset",
  description: "A Google BigQuery dataset",
  fields: [
    f("name", "Dataset ID"),
    f("friendlyName", "Friendly Name", { required: false }),
    f("location", "Location", { required: false }),
    f("description", "Description", { required: false }),
    f("defaultTableExpirationMs", "Default table expiration (ms)", {
      kind: "number",
      required: false,
    }),
    f("defaultPartitionExpirationMs", "Default partition expiration (ms)", {
      kind: "number",
      required: false,
    }),
    f("defaultCollation", "Default collation", { required: false }),
    f("defaultRoundingMode", "Default rounding mode", { required: false }),
    f("isCaseInsensitive", "Case insensitive", { kind: "boolean", required: false }),
    f("storageBillingModel", "Storage billing model", { required: false }),
    f("maxTimeTravelHours", "Max time travel (hours)", { kind: "number", required: false }),
    f("labels", "Labels", { required: false }),
    f("creationTime", "Created", { required: false }),
    f("lastModifiedTime", "Last modified", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
