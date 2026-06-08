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
  iconKey: "network",
});
