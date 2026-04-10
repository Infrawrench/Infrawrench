import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const LogpushJobResourceType: ResourceTypeDefinition = {
  id: "logpush-job",
  displayName: "Logpush Job",
  pluralDisplayName: "Logpush Jobs",
  description: "A Cloudflare Logpush job for streaming logs to a destination",
  fields: [
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "enabled", label: "Enabled", kind: "boolean", required: true },
    { key: "dataset", label: "Dataset", kind: "string", required: true },
    { key: "destinationType", label: "Destination Type", kind: "string", required: false },
    { key: "frequency", label: "Frequency", kind: "string", required: false },
    { key: "logpullOptions", label: "Logpull Options", kind: "string", required: false },
    { key: "lastComplete", label: "Last Complete", kind: "string", required: false },
    { key: "lastError", label: "Last Error", kind: "string", required: false },
  ],
  outputs: [],
  parentTypeId: "zone",
  dashboardPinnable: false,
  iconKey: "logs",
};
