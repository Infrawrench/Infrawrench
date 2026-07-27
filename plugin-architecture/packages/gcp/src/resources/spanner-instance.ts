import { f, rt } from "@infrawrench/plugin-base";

export const SpannerInstanceResourceType = rt({
  name: "Spanner Instance",
  id: "spanner-instance",
  description: "A Google Cloud Spanner instance",
  fields: [
    f("name", "Name"),
    f("displayName", "Display Name", { required: false }),
    f("config", "Instance Config", { required: false }),
    f("nodeCount", "Node Count", { kind: "number", required: false }),
    f("processingUnits", "Processing Units", { kind: "number", required: false }),
    f("state", "State", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
});
