import { f, o, rt } from "@infrawrench/plugin-base";

export const FirewallResourceType = rt({
  name: "Firewall",
  id: "azure-firewall",
  description: "An Azure Firewall for network traffic filtering and protection",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("sku", "SKU"),
    f("tier", "Tier"),
    f("provisioningState", "Provisioning State"),
    f("threatIntelMode", "Threat Intel Mode", { required: false }),
  ],
  outputs: [o("privateIp", "Private IP")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  supportsMetrics: true,
  iconKey: "firewall",
});
