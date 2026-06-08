import { f, o, rt } from "@infrawrench/plugin-base";

export const NSGResourceType = rt({
  name: "Network Security Group",
  id: "azure-nsg",
  description: "An Azure Network Security Group",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("provisioningState", "Provisioning State"),
    f("securityRuleCount", "Security Rules", { kind: "number", required: false }),
    f("subnetCount", "Associated Subnets", { kind: "number", required: false }),
    f("nicCount", "Associated NICs", { kind: "number", required: false }),
  ],
  outputs: [o("resourceId", "Resource ID")],
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
