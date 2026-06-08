import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SubnetResourceType: ResourceTypeDefinition = {
  id: "azure-subnet",
  displayName: "Subnet",
  pluralDisplayName: "Subnets",
  description: "An Azure virtual network subnet",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: false },
    { key: "vnetName", label: "Virtual Network", kind: "string", required: true },
    { key: "addressPrefix", label: "Address Prefix", kind: "string", required: false },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: false },
    {
      key: "networkSecurityGroup",
      label: "Network Security Group",
      kind: "string",
      required: false,
    },
    { key: "routeTable", label: "Route Table", kind: "string", required: false },
    { key: "natGateway", label: "NAT Gateway", kind: "string", required: false },
  ],
  outputs: [{ key: "resourceId", label: "Resource ID", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "network",
};
