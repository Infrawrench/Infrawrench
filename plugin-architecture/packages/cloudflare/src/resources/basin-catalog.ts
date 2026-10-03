import { f, o, rt } from "@infrawrench/plugin-base";

const MAINTENANCE_DESCRIPTION =
  "Runs as a background job using the stored service token (see Maintenance Token)";

export const BasinCatalogResourceType = rt({
  name: "Basin Catalog",
  id: "basin-catalog",
  description:
    "A Cloudflare Basin Catalog: the managed Apache Iceberg REST catalog enabled on an R2 bucket, queryable with Basin SQL",
  fields: [
    f("bucket", "R2 Bucket", { editable: false }),
    f("warehouseName", "Warehouse", { required: false, editable: false }),
    f("catalogUri", "Catalog URI", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("credentialStatus", "Maintenance Credential", { required: false, editable: false }),
    f("compaction", "Compaction", {
      kind: "enum",
      enumValues: ["enabled", "disabled"],
      required: false,
      description: MAINTENANCE_DESCRIPTION,
    }),
    f("targetSizeMb", "Compaction Target File Size (MB)", {
      kind: "enum",
      enumValues: ["64", "128", "256", "512"],
      required: false,
    }),
    f("snapshotExpiration", "Snapshot Expiration", {
      kind: "enum",
      enumValues: ["enabled", "disabled"],
      required: false,
      description: MAINTENANCE_DESCRIPTION,
    }),
    f("maxSnapshotAge", "Max Snapshot Age", {
      required: false,
      description: 'Expire snapshots older than this, e.g. "30d" or "12h" (a bare number is days)',
    }),
    f("minSnapshotsToKeep", "Min Snapshots to Keep", { kind: "number", required: false }),
    f("maintenanceToken", "Maintenance Token", {
      kind: "password",
      required: false,
      description:
        "API token maintenance jobs use (needs R2 Storage and Data Catalog write). Leave blank to keep the stored one; if none is stored, this account's token is used.",
    }),
  ],
  outputs: [
    o("warehouseName", "Warehouse Name"),
    o("catalogUri", "Catalog URI", { description: "Iceberg REST catalog URI" }),
    o("bucketName", "Bucket Name"),
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  supportsRestQuery: true,
  iconKey: "database",
  secretExportTemplates: [
    {
      id: "iceberg-catalog",
      displayName: "Iceberg Catalog",
      description: "Catalog URI and warehouse for PyIceberg, Spark, DuckDB, Trino or Snowflake",
      entries: [
        { envKey: "ICEBERG_CATALOG_URI", outputKey: "catalogUri" },
        { envKey: "ICEBERG_WAREHOUSE", outputKey: "warehouseName" },
      ],
    },
  ],
});
