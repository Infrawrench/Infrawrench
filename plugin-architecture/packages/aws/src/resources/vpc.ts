import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VPCResourceType: ResourceTypeDefinition = {
  id: "vpc",
  displayName: "VPC",
  pluralDisplayName: "VPCs",
  description: "An Amazon Virtual Private Cloud network",
  fields: [
    { key: "vpcId", label: "VPC ID", kind: "string", required: true },
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "cidrBlock", label: "CIDR Block", kind: "string", required: true },
    { key: "state", label: "State", kind: "string", required: true },
    { key: "isDefault", label: "Default VPC", kind: "boolean", required: false },
    { key: "tenancy", label: "Tenancy", kind: "string", required: false },
  ],
  outputs: [{ key: "vpcId", label: "VPC ID", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "network",
  supportsCreate: true,
};
