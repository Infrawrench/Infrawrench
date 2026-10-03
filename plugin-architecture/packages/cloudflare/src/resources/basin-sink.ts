import { f, o, rt } from "@infrawrench/plugin-base";

export const BasinSinkResourceType = rt({
  name: "Basin Sink",
  id: "basin-sink",
  description:
    "A Cloudflare Basin Pipelines sink: where a pipeline writes, either a Basin Catalog (Iceberg) table or files in R2",
  fields: [
    f("name", "Name"),
    f("type", "Destination", { required: false }),
    f("bucket", "R2 Bucket", { required: false }),
    f("namespace", "Namespace", { required: false }),
    f("tableName", "Table", { required: false }),
    f("path", "Path Prefix", { required: false }),
    f("partitioning", "Partitioning", { required: false }),
    f("jurisdiction", "Jurisdiction", { required: false }),
    f("format", "Format", { required: false }),
    f("compression", "Compression", { required: false }),
    f("rollIntervalSeconds", "Roll Interval (s)", { kind: "number", required: false }),
    f("rollSizeMb", "Roll Size (MB)", { kind: "number", required: false }),
    f("createdAt", "Created", { required: false }),
    f("modifiedAt", "Modified", { required: false }),
  ],
  outputs: [o("sinkId", "Sink ID"), o("sinkName", "Sink Name")],
  supportsCreate: true,
  supportsMetrics: true,
  iconKey: "storage",
});
