import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const CloudFunctionResourceType: ResourceTypeDefinition = {
  id: "cloud-function",
  displayName: "Cloud Function",
  pluralDisplayName: "Cloud Functions",
  description: "A Google Cloud Function (2nd gen)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "runtime", label: "Runtime", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
    { key: "availableMemory", label: "Memory", kind: "string", required: false },
    { key: "timeout", label: "Timeout", kind: "string", required: false },
  ],
  outputs: [{ key: "url", label: "Trigger URL", sensitive: false }],
  dashboardPinnable: true,
};
