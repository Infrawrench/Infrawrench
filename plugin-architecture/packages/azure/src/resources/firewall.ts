import { f, o, rt } from "@infrawrench/plugin-base";

export const FirewallResourceType = rt({
  name: "Firewall",
  id: "azure-firewall",
  description: "An Azure Firewall for network traffic filtering and protection",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group", { showcase: true }),
    f("location", "Location", { showcase: true }),
    f("sku", "SKU"),
    f("tier", "Tier", { showcase: true }),
    f("provisioningState", "Provisioning State", { showcase: true }),
    f("threatIntelMode", "Threat Intel Mode", { required: false }),
  ],
  outputs: [o("privateIp", "Private IP")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  supportsMetrics: true,
  iconKey: "firewall",
});
