import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NatGatewayResourceType: ResourceTypeDefinition = {
  id: "azure-nat-gateway",
  displayName: "NAT Gateway",
  pluralDisplayName: "NAT Gateways",
  description: "An Azure NAT Gateway",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "sku", label: "SKU", kind: "string", required: false },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: false },
    { key: "idleTimeout", label: "Idle Timeout", kind: "number", required: false },
    { key: "publicIpCount", label: "Public IPs", kind: "number", required: false },
    { key: "subnetCount", label: "Associated Subnets", kind: "number", required: false },
  ],
  outputs: [{ key: "resourceId", label: "Resource ID", sensitive: false }],
  dashboardPinnable: true,
  supportsMetrics: true,
  iconKey: "network",
  attachTargets: [
    {
      pluginId: "azure",
      resourceTypeId: "azure-subnet",
      matchField: "location",
      verb: "Associate",
    },
  ],
};
