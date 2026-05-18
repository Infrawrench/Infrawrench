import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AppResourceType: ResourceTypeDefinition = {
  id: "app",
  displayName: "App",
  pluralDisplayName: "Apps",
  description: "A Fly.io application that groups machines, volumes, and networking",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      required: true,
      enumValues: ["deployed", "pending", "suspended"],
    },
    {
      key: "organization",
      label: "Organization",
      kind: "string",
      required: false,
      description: "Organization the app belongs to",
    },
    {
      key: "machineCount",
      label: "Machines",
      kind: "number",
      required: false,
      description: "Number of machines in this app",
    },
    {
      key: "volumeCount",
      label: "Volumes",
      kind: "number",
      required: false,
      description: "Number of volumes in this app",
    },
    {
      key: "network",
      label: "Network",
      kind: "string",
      required: false,
      description: "Private network name",
    },
  ],
  outputs: [
    {
      key: "hostname",
      label: "Hostname",
      sensitive: false,
      description: "Public hostname (<app>.fly.dev)",
    },
  ],
  dashboardPinnable: true,
  iconKey: "app",
  supportsCreate: true,
  supportsMetrics: true,
};
