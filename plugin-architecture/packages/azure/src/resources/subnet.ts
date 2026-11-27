import { f, o, rt } from "@infrawrench/plugin-base";

export const SubnetResourceType = rt({
  name: "Subnet",
  id: "azure-subnet",
  description: "An Azure virtual network subnet",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group", { showcase: true }),
    f("location", "Location", { showcase: true, required: false }),
    f("vnetName", "Virtual Network"),
    f("addressPrefix", "Address Prefix", { required: false }),
    f("provisioningState", "Provisioning State", { showcase: true, required: false }),
    f("networkSecurityGroup", "Network Security Group", { required: false }),
    f("routeTable", "Route Table", { required: false }),
    f("natGateway", "NAT Gateway", { required: false }),
    // The virtual network's usages API reports each subnet's used IP addresses
    // against its size (`SubnetSpace`); the lister reads it once per network.
    // https://learn.microsoft.com/rest/api/virtualnetwork/virtual-networks/list-usage
    // (read 2026-11-23)
    f("ipAddressesUsed", "IP Addresses Used", {
      kind: "number",
      required: false,
      editable: false,
      usage: { limit: { field: "ipAddressCapacity" }, unit: "IP addresses" },
    }),
    f("ipAddressCapacity", "IP Address Capacity", {
      kind: "number",
      required: false,
      editable: false,
      description: "Addresses the subnet can hand out, as Azure reports its size",
    }),
  ],
  outputs: [o("resourceId", "Resource ID")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
    { fieldKey: "vnetName", targetTypeId: "azure-vnet", targetKey: "name", label: "in VNet" },
    {
      fieldKey: "networkSecurityGroup",
      targetTypeId: "azure-nsg",
      targetKey: "name",
      label: "guarded by",
    },
    {
      fieldKey: "routeTable",
      targetTypeId: "azure-route-table",
      targetKey: "name",
      label: "routed by",
    },
    {
      fieldKey: "natGateway",
      targetTypeId: "azure-nat-gateway",
      targetKey: "name",
      label: "egress via",
    },
  ],
  iconKey: "network",
});
