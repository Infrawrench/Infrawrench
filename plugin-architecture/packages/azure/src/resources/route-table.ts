import { f, o, rt } from "@infrawrench/plugin-base";

export const RouteTableResourceType = rt({
  name: "Route Table",
  id: "azure-route-table",
  description: "An Azure route table",
  fields: [
    f("name", "Name"),
    f("resourceGroup", "Resource Group"),
    f("location", "Location", { showcase: true }),
    f("provisioningState", "Provisioning State", { showcase: true, required: false }),
    // "User-defined routes per route table: 1,000" (Networking limits, Azure Resource
    // Manager), read 2026-11-23 at
    // https://learn.microsoft.com/azure/azure-resource-manager/management/azure-subscription-service-limits#azure-resource-manager-virtual-networking-limits
    f("routeCount", "Routes", {
      showcase: true,
      kind: "number",
      required: false,
      usage: { limit: { constant: 1000 }, unit: "routes" },
    }),
    f("subnetCount", "Associated Subnets", { showcase: true, kind: "number", required: false }),
  ],
  outputs: [o("resourceId", "Resource ID")],
  dependsOn: [
    { fieldKey: "resourceGroup", targetTypeId: "azure-resource-group", label: "in resource group" },
  ],
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
