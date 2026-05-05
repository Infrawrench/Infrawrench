import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VpcNetworkResourceType: ResourceTypeDefinition = {
  id: "vpc-network",
  displayName: "VPC Network",
  pluralDisplayName: "VPC Networks",
  description: "A Google Cloud VPC network",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "autoCreateSubnetworks", label: "Auto Subnets", kind: "boolean", required: false },
    { key: "mtu", label: "MTU", kind: "number", required: false },
    { key: "subnetCount", label: "Subnet Count", kind: "number", required: false },
  ],
  outputs: [{ key: "selfLink", label: "Self Link", sensitive: false }],
  dashboardPinnable: false,
  supportsCreate: true,
};
