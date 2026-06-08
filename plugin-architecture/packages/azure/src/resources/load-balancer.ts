import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const LoadBalancerResourceType: ResourceTypeDefinition = {
  id: "azure-load-balancer",
  displayName: "Load Balancer",
  pluralDisplayName: "Load Balancers",
  description: "An Azure Load Balancer",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "sku", label: "SKU", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "frontendIpCount", label: "Frontend IPs", kind: "number", required: false },
    { key: "backendPoolCount", label: "Backend Pools", kind: "number", required: false },
    { key: "ruleCount", label: "Rules", kind: "number", required: false },
  ],
  outputs: [{ key: "frontendIp", label: "Frontend IP", sensitive: false }],
  dashboardPinnable: true,
  supportsCreate: true,
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
