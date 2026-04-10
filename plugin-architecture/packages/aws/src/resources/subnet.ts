import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SubnetResourceType: ResourceTypeDefinition = {
  id: "subnet",
  displayName: "Subnet",
  pluralDisplayName: "Subnets",
  description: "An AWS VPC subnet",
  parentTypeId: "vpc",
  fields: [
    { key: "subnetId", label: "Subnet ID", kind: "string", required: true },
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "vpcId", label: "VPC ID", kind: "string", required: true },
    { key: "cidrBlock", label: "CIDR Block", kind: "string", required: true },
    { key: "availabilityZone", label: "Availability Zone", kind: "string", required: true },
    { key: "state", label: "State", kind: "string", required: true },
    { key: "availableIps", label: "Available IPs", kind: "number", required: false },
    { key: "mapPublicIp", label: "Map Public IP", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "subnetArn", label: "Subnet ARN", sensitive: false },
  ],
  dashboardPinnable: false,
  iconKey: "network",
};
