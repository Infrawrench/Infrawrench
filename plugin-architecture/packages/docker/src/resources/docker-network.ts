import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const DockerNetworkResourceType: ResourceTypeDefinition = {
  id: "docker-network",
  displayName: "Network",
  pluralDisplayName: "Networks",
  description: "A Docker network managed by the local or remote Docker daemon.",
  fields: [
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "driver", label: "Driver", kind: "string", required: false },
    { key: "scope", label: "Scope", kind: "string", required: false },
    { key: "subnet", label: "Subnet", kind: "string", required: false },
    { key: "internal", label: "Internal", kind: "boolean", required: false },
  ],
  outputs: [{ key: "networkId", label: "Network ID", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "network",
};
