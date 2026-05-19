import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const NSGResourceType: ResourceTypeDefinition = {
  id: "azure-nsg",
  displayName: "Network Security Group",
  pluralDisplayName: "Network Security Groups",
  description: "An Azure Network Security Group",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: true },
    { key: "securityRuleCount", label: "Security Rules", kind: "number", required: false },
    { key: "subnetCount", label: "Associated Subnets", kind: "number", required: false },
    { key: "nicCount", label: "Associated NICs", kind: "number", required: false },
  ],
  outputs: [{ key: "resourceId", label: "Resource ID", sensitive: false }],
  dashboardPinnable: true,
  // NSG does not publish Azure Monitor numeric metrics — the reference page 404s
  // (https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-network-networksecuritygroups-metrics).
  // Flow-log analytics are the recommended observability surface for NSGs.
  iconKey: "firewall",
  supportsCreate: true,
  attachTargets: [{ pluginId: "azure", resourceTypeId: "azure-vm", verb: "Apply NSG" }],
};
