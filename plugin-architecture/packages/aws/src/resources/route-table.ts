import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const RouteTableResourceType: ResourceTypeDefinition = {
  id: "route-table",
  displayName: "Route Table",
  pluralDisplayName: "Route Tables",
  description: "An AWS VPC route table",
  parentTypeId: "vpc",
  fields: [
    { key: "routeTableId", label: "Route Table ID", kind: "string", required: true },
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "vpcId", label: "VPC ID", kind: "string", required: true },
    { key: "main", label: "Main", kind: "boolean", required: false },
    { key: "routeCount", label: "Routes", kind: "number", required: false },
    { key: "associationCount", label: "Associations", kind: "number", required: false },
  ],
  outputs: [{ key: "routeTableId", label: "Route Table ID", sensitive: false }],
  dashboardPinnable: false,
  iconKey: "network",
  attachTargets: [
    { pluginId: "aws", resourceTypeId: "subnet", matchField: "vpcId", verb: "Associate" },
  ],
};
