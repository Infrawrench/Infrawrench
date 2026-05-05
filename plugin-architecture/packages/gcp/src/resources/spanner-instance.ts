import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SpannerInstanceResourceType: ResourceTypeDefinition = {
  id: "spanner-instance",
  displayName: "Spanner Instance",
  pluralDisplayName: "Spanner Instances",
  description: "A Google Cloud Spanner instance",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "displayName", label: "Display Name", kind: "string", required: false },
    { key: "config", label: "Instance Config", kind: "string", required: false },
    { key: "nodeCount", label: "Node Count", kind: "number", required: false },
    { key: "processingUnits", label: "Processing Units", kind: "number", required: false },
    { key: "state", label: "State", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
};
