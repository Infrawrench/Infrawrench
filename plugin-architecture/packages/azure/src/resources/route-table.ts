import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const RouteTableResourceType: ResourceTypeDefinition = {
  id: "azure-route-table",
  displayName: "Route Table",
  pluralDisplayName: "Route Tables",
  description: "An Azure route table",
  fields: [
    { key: "name", label: "Name", kind: "string", required: true },
    { key: "resourceGroup", label: "Resource Group", kind: "string", required: true },
    { key: "location", label: "Location", kind: "string", required: true },
    { key: "provisioningState", label: "Provisioning State", kind: "string", required: false },
    { key: "routeCount", label: "Routes", kind: "number", required: false },
    { key: "subnetCount", label: "Associated Subnets", kind: "number", required: false },
  ],
  outputs: [{ key: "resourceId", label: "Resource ID", sensitive: false }],
  dashboardPinnable: true,
  iconKey: "network",
  attachTargets: [
    {
      pluginId: "azure",
      resourceTypeId: "azure-subnet",
      matchField: "location",
      verb: "Associate",
    },
  ],
};
