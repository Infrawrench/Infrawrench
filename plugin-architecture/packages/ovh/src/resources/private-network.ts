import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PrivateNetworkResourceType: ResourceTypeDefinition = {
  id: "private-network",
  displayName: "Private Network",
  pluralDisplayName: "Private Networks",
  description: "An OVHcloud Public Cloud private network",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "regions", label: "Regions", kind: "string", required: false },
    { key: "vlanId", label: "VLAN ID", kind: "number", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "type", label: "Type", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: true,
  supportsCreate: true,
  iconKey: "network",
};
