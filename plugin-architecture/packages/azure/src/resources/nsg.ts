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
    f("securityRuleCount", "Security Rules", { showcase: true, kind: "number", required: false }),
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
