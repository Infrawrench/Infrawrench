import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const VNetResourceType: ResourceTypeDefinition = {
  id: "azure-vnet",
  displayName: "Virtual Network",
  pluralDisplayName: "Virtual Networks",
  description: "An Azure Virtual Network",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "addressPrefixes", label: "Address Prefixes", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "subnetCount", label: "Subnets", kind: "number", required: false },
    { key: "enableDdosProtection", label: "DDoS Protection", kind: "boolean", required: false },
  ],
  outputs: [
    { key: "resourceId", label: "Resource ID", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "network",
  supportsCreate: true,
};
