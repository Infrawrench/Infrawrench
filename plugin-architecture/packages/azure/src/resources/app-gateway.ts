import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const AppGatewayResourceType: ResourceTypeDefinition = {
  id: "azure-app-gateway",
  displayName: "Application Gateway",
  pluralDisplayName: "Application Gateways",
  description: "An Azure Application Gateway (Layer 7 load balancer)",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "sku", label: "SKU", kind: "string", required: true },
    { key: "tier", label: "Tier", kind: "string", required: true },
    { key: "capacity", label: "Capacity", kind: "number", required: false },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "operationalState", label: "Operational State", kind: "string", required: false },
    { key: "backendPoolCount", label: "Backend Pools", kind: "number", required: false },
    { key: "httpListenerCount", label: "HTTP Listeners", kind: "number", required: false },
  ],
  outputs: [{ key: "frontendIp", label: "Frontend IP", sensitive: false }],
  dashboardPinnable: true,
  supportsMetrics: true,
  iconKey: "network",
  attachTargets: [
    {
      pluginId: "azure",
      resourceTypeId: "azure-vm",
      matchField: "location",
      verb: "Add backend",
    },
  ],
};
