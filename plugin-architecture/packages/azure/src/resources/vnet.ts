import { f, o, rt } from "@infrawrench/plugin-base";

export const VNetResourceType = rt({
  name: "Virtual Network",
  id: "azure-vnet",
  description: "An Azure Virtual Network",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("addressPrefixes", "Address Prefixes"),
    f("provisioningState", "Provisioning State"),
    f("subnetCount", "Subnets", { kind: "number", required: false }),
    f("enableDdosProtection", "DDoS Protection", { kind: "boolean", required: false }),
  ],
  outputs: [o("resourceId", "Resource ID")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  iconKey: "network",
  supportsCreate: true,
});
