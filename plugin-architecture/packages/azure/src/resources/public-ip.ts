import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const PublicIPResourceType: ResourceTypeDefinition = {
  id: "azure-public-ip",
  displayName: "Public IP Address",
  pluralDisplayName: "Public IP Addresses",
  description: "An Azure Public IP Address",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "sku", label: "SKU", kind: "string", required: true },
    { key: "allocationMethod", label: "Allocation Method", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "ipVersion", label: "IP Version", kind: "string", required: false },
  ],
  outputs: [
    { key: "ipAddress", label: "IP Address", sensitive: false },
    { key: "fqdn", label: "FQDN", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "network",
  supportsCreate: true,
  supportsMetrics: true,
  attachTargets: [
    {
      pluginId: "azure",
      resourceTypeId: "azure-vm",
      matchField: "location",
      verb: "Attach public IP",
    },
  ],
};
