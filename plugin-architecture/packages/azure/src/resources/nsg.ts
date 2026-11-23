import { f, o, rt } from "@infrawrench/plugin-base";

export const NSGResourceType = rt({
  name: "Network Security Group",
  id: "azure-nsg",
  description: "An Azure Network Security Group",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location", { showcase: true }),
    f("provisioningState", "Provisioning State", { showcase: true }),
    // "NSG rules per NSG: 2,000" (Networking limits, Azure Resource Manager), read
    // 2026-11-23 at https://learn.microsoft.com/azure/azure-resource-manager/management/azure-subscription-service-limits#azure-resource-manager-virtual-networking-limits
    f("securityRuleCount", "Security Rules", {
      showcase: true,
      kind: "number",
      required: false,
      usage: { limit: { constant: 2000 }, unit: "rules" },
    }),
    f("subnetCount", "Associated Subnets", { showcase: true, kind: "number", required: false }),
    f("nicCount", "Associated NICs", { kind: "number", required: false }),
  ],
  outputs: [o("resourceId", "Resource ID")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  iconKey: "firewall",
  supportsCreate: true,
  attachTargets: [
    { pluginId: "azure", resourceTypeId: "azure-vm", verb: "Apply NSG" },
    {
      pluginId: "azure",
      resourceTypeId: "azure-subnet",
      matchField: "location",
      verb: "Apply NSG",
    },
  ],
});
