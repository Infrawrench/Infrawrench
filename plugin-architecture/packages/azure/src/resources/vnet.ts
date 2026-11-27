import { f, o, rt } from "@infrawrench/plugin-base";

export const VNetResourceType = rt({
  name: "Virtual Network",
  id: "azure-vnet",
  description: "An Azure Virtual Network",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group", { showcase: true }),
    f("location", "Location", { showcase: true }),
    f("addressPrefixes", "Address Prefixes"),
    f("provisioningState", "Provisioning State", { showcase: true }),
    // "Subnets per virtual network: 3,000" (Networking limits), read 2026-11-23 at
    // https://learn.microsoft.com/azure/azure-resource-manager/management/azure-subscription-service-limits#azure-resource-manager-virtual-networking-limits
    f("subnetCount", "Subnets", {
      showcase: true,
      kind: "number",
      required: false,
      usage: { limit: { constant: 3000 }, unit: "subnets" },
    }),
    f("enableDdosProtection", "DDoS Protection", { kind: "boolean", required: false }),
  ],
  outputs: [o("resourceId", "Resource ID")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  iconKey: "network",
  supportsCreate: true,
});
