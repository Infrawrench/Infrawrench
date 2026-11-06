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
});
