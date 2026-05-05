import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NATGatewayResourceType: ResourceTypeDefinition = {
  id: "nat-gateway",
  displayName: "NAT Gateway",
  pluralDisplayName: "NAT Gateways",
  description: "An AWS VPC NAT gateway",
  fields: [
    { key: "natGatewayId", label: "NAT Gateway ID", kind: "string", required: true },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
      enumValues: ["pending", "failed", "available", "deleting", "deleted"],
    },
    { key: "subnetId", label: "Subnet ID", kind: "string", required: false },
    { key: "vpcId", label: "VPC ID", kind: "string", required: false },
    {
      key: "connectivityType",
      label: "Connectivity",
      kind: "enum",
      required: false,
      enumValues: ["public", "private"],
    },
    { key: "publicIp", label: "Public IP", kind: "string", required: false },
    { key: "privateIp", label: "Private IP", kind: "string", required: false },
  ],
  outputs: [{ key: "natGatewayId", label: "NAT Gateway ID", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "network",
  supportsCreate: true,
};
