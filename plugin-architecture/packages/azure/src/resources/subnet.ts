import { f, o, rt } from "@infrawrench/plugin-base";

export const SubnetResourceType = rt({
  name: "Subnet",
  id: "azure-subnet",
  description: "An Azure virtual network subnet",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location", { required: false }),
    f("vnetName", "Virtual Network"),
    f("addressPrefix", "Address Prefix", { required: false }),
    f("provisioningState", "Provisioning State", { required: false }),
    f("networkSecurityGroup", "Network Security Group", { required: false }),
    f("routeTable", "Route Table", { required: false }),
    f("natGateway", "NAT Gateway", { required: false }),
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
