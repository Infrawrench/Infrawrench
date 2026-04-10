import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const FirewallResourceType: ResourceTypeDefinition = {
  id: "azure-firewall",
  displayName: "Firewall",
  pluralDisplayName: "Firewalls",
  description: "An Azure Firewall for network traffic filtering and protection",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "sku", label: "SKU", kind: "string", required: true },
    { key: "tier", label: "Tier", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "threatIntelMode", label: "Threat Intel Mode", kind: "string", required: false },
  ],
  outputs: [
    { key: "privateIp", label: "Private IP", sensitive: false },
  ],
  dashboardPinnable: true,
  iconKey: "firewall",
};
