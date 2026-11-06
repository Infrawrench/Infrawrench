import { f, o, rt } from "@infrawrench/plugin-base";

export const PublicIPResourceType = rt({
  name: "Public IP Address",
  plural: "Public IP Addresses",
  id: "azure-public-ip",
  description: "An Azure Public IP Address",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group", { showcase: true }),
    f("location", "Location", { showcase: true }),
    f("sku", "SKU", { showcase: true }),
    f("allocationMethod", "Allocation Method"),
    f("provisioningState", "Provisioning State", { showcase: true }),
    f("ipVersion", "IP Version", { required: false }),
  ],
  outputs: [
    o("ipAddress", "IP Address", { dnsValue: "ipv4" }),
    o("fqdn", "FQDN", { dnsValue: "hostname" }),
  ],
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
