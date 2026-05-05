import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SubnetResourceType: ResourceTypeDefinition = {
  id: "subnet",
  displayName: "Subnet",
  pluralDisplayName: "Subnets",
  description: "A Google Cloud VPC subnetwork",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "region", label: "Region", kind: "string", required: true },
    { key: "network", label: "Network", kind: "string", required: false },
    { key: "ipCidrRange", label: "IP CIDR Range", kind: "string", required: true },
    { key: "gatewayAddress", label: "Gateway", kind: "string", required: false },
    {
      key: "privateIpGoogleAccess",
      label: "Private Google Access",
      kind: "boolean",
      required: false,
    },
    { key: "purpose", label: "Purpose", kind: "string", required: false },
    { key: "stackType", label: "Stack Type", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
  supportsCreate: true,
};
