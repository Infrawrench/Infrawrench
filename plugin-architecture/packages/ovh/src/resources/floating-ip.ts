import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const FloatingIpResourceType: ResourceTypeDefinition = {
  id: "floating-ip",
  displayName: "Floating IP",
  pluralDisplayName: "Floating IPs",
  description: "An OVHcloud Public Cloud floating IP",
  fields: [
    { key: "ip", label: "IP", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "networkId", label: "Network ID", kind: "string", required: false },
    { key: "associatedEntity", label: "Associated Entity", kind: "string", required: false },
  ],
  outputs: [{ key: "ip", label: "IP", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "ip",
};
