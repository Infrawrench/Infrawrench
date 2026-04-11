import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const StaticIpResourceType: ResourceTypeDefinition = {
  id: "static-ip",
  displayName: "Static IP",
  pluralDisplayName: "Static IPs",
  description: "A Google Cloud reserved static external IP address",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: false },
    { key: "address", label: "Address", kind: "string", required: false },
    { key: "addressType", label: "Type", kind: "string", required: false },
    { key: "status", label: "Status", kind: "string", required: false },
    { key: "networkTier", label: "Network Tier", kind: "string", required: false },
    { key: "ipVersion", label: "IP Version", kind: "string", required: false },
  ],
  outputs: [{ key: "address", label: "IP Address", sensitive: false }],
  dashboardPinnable: true,
};
