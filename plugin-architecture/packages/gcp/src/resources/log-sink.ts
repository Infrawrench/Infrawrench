import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const LogSinkResourceType: ResourceTypeDefinition = {
  id: "log-sink",
  displayName: "Log Sink",
  pluralDisplayName: "Log Sinks",
  description: "A Google Cloud Logging sink (log router)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "destination", label: "Destination", kind: "string", required: false },
    { key: "filter", label: "Filter", kind: "string", required: false },
    { key: "disabled", label: "Disabled", kind: "boolean", required: false },
    { key: "writerIdentity", label: "Writer Identity", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
  supportsCreate: true,
};
