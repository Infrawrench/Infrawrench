import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const IpAllocationResourceType: ResourceTypeDefinition = {
  id: "ip-allocation",
  displayName: "IP Allocation",
  pluralDisplayName: "IP Allocations",
  description: "A public IPv4 or IPv6 allocation for a Fly.io app",
  parentTypeId: "app",
  fields: [
    { key: "address", label: "Address", kind: "string", required: true },
    { key: "appName", label: "App", kind: "string", required: true },
    { key: "type", label: "Type", kind: "string", required: false },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "network", label: "Network", kind: "string", required: false },
    { key: "private", label: "Private", kind: "boolean", required: false },
  ],
  outputs: [{ key: "address", label: "Address", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "network",
};
