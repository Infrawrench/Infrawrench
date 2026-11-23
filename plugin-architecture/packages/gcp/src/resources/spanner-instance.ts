import { f, rt } from "@infrawrench/plugin-base";

export const SpannerInstanceResourceType = rt({
  name: "Spanner Instance",
  id: "spanner-instance",
  iconKey: "database",
  description: "A Google Cloud Spanner instance",
  fields: [
    f("name", "Name"),
    f("displayName", "Display Name", { required: false }),
    f("config", "Instance Config", { required: false }),
    f("nodeCount", "Node Count", { showcase: true, kind: "number", required: false }),
    f("processingUnits", "Processing Units", { kind: "number", required: false }),
    f("state", "State", { showcase: true, required: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsMetrics: true,
  // `instance/storage/utilization` ("Storage used as a fraction of storage
  // limit", per storage class), charted as 0..100 for the fuller class under
  // this label. The limit scales with nodes or processing units:
  // https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z, read 2026-11-23
  capacityMetrics: [
    { seriesLabel: "Storage Utilization", limit: { constant: 100 }, unit: "%", label: "Storage" },
  ],
});
