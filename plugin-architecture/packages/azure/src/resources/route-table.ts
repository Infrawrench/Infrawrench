import { f, o, rt } from "@infrawrench/plugin-base";

export const RouteTableResourceType = rt({
  name: "Route Table",
  id: "azure-route-table",
  description: "An Azure route table",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location"),
    f("provisioningState", "Provisioning State", { required: false }),
    f("routeCount", "Routes", { kind: "number", required: false }),
    f("subnetCount", "Associated Subnets", { kind: "number", required: false }),
  ],
  outputs: [o("resourceId", "Resource ID")],
  iconKey: "network",
  attachTargets: [
    {
      pluginId: "azure",
      resourceTypeId: "azure-subnet",
      matchField: "location",
      verb: "Associate",
    },
  ],
});
