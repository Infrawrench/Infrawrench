import { f, o, rt } from "@infrawrench/plugin-base";

export const PublicIPResourceType = rt({
  name: "Public IP Address",
  plural: "Public IP Addresses",
  id: "azure-public-ip",
  description: "An Azure Public IP Address",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("sku", "SKU"),
    f("allocationMethod", "Allocation Method"),
    f("provisioningState", "Provisioning State"),
    f("ipVersion", "IP Version", { required: false }),
  ],
  outputs: [o("ipAddress", "IP Address"), o("fqdn", "FQDN")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
  iconKey: "network",
  supportsCreate: true,
  supportsMetrics: true,
  attachTargets: [
    {
      pluginId: "azure",
      resourceTypeId: "azure-vm",
      matchField: "location",
      verb: "Attach public IP",
    },
    {
      pluginId: "azure",
      resourceTypeId: "azure-nat-gateway",
      matchField: "location",
      verb: "Use for NAT",
    },
  ],
});
