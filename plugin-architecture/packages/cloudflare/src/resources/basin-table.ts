import { f, o, rt } from "@infrawrench/plugin-base";

export const BasinTableResourceType = rt({
  name: "Basin Table",
  id: "basin-table",
  description: "An Apache Iceberg table in a Cloudflare Basin Catalog, queryable with Basin SQL",
  fields: [
    f("name", "Name", { editable: false }),
    f("namespace", "Namespace", { editable: false }),
    f("bucket", "R2 Bucket", { editable: false }),
    f("tableUuid", "Table UUID", { required: false, editable: false }),
    f("location", "Location", { required: false, editable: false }),
    f("metadataLocation", "Metadata Location", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
    f("compaction", "Compaction", {
      kind: "enum",
      enumValues: ["enabled", "disabled"],
      required: false,
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
    }),
    f("maxSnapshotAge", "Max Snapshot Age", {
      required: false,
      description: 'Expire snapshots older than this, e.g. "30d" or "12h" (a bare number is days)',
    }),
    f("minSnapshotsToKeep", "Min Snapshots to Keep", { kind: "number", required: false }),
  ],
  outputs: [o("tableName", "Qualified Table Name"), o("bucketName", "Bucket Name")],
  parentTypeId: "basin-catalog",
  showInSidebar: true,
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
  supportsRestQuery: true,
  iconKey: "database",
});
