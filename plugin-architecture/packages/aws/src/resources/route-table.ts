import { f, o, rt } from "@infrawrench/plugin-base";

export const RouteTableResourceType = rt({
  name: "Route Table",
  pinnable: false,
  id: "route-table",
  description: "An AWS VPC route table",
  parentTypeId: "vpc",
  fields: [
    f("routeTableId", "Route Table ID"),
    f("name", "Name", { required: false }),
    f("vpcId", "VPC ID"),
    f("main", "Main", { kind: "boolean", required: false }),
    f("routeCount", "Routes", { kind: "number", required: false }),
    f("associationCount", "Associations", { kind: "number", required: false }),
  ],
  outputs: [o("routeTableId", "Route Table ID")],
  iconKey: "network",
  attachTargets: [
    { pluginId: "aws", resourceTypeId: "subnet", matchField: "vpcId", verb: "Associate" },
  ],
});
