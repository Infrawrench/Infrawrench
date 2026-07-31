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
    f("natGatewayIds", "NAT Gateways", {
      required: false,
      description: "Comma-separated NAT gateway IDs this table routes through",
    }),
    f("internetGatewayIds", "Internet Gateways", {
      required: false,
      description: "Comma-separated internet gateway IDs this table routes through",
    }),
  ],
  outputs: [o("routeTableId", "Route Table ID")],
  dependsOn: [
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
    { fieldKey: "natGatewayIds", targetTypeId: "nat-gateway", label: "routes via" },
    { fieldKey: "internetGatewayIds", targetTypeId: "internet-gateway", label: "routes via" },
  ],
  iconKey: "network",
  attachTargets: [
    { pluginId: "aws", resourceTypeId: "subnet", matchField: "vpcId", verb: "Associate" },
  ],
});
