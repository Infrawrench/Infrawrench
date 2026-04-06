import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DataflowJobResourceType: ResourceTypeDefinition = {
  id: "dataflow-job",
  displayName: "Dataflow Job",
  pluralDisplayName: "Dataflow Jobs",
  description: "A Google Cloud Dataflow streaming or batch job",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "type", label: "Job Type", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "sdkVersion", label: "SDK Version", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
};
