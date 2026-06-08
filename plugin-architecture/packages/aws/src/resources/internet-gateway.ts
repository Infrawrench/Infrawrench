import { f, o, rt } from "@infrawrench/plugin-base";

export const InternetGatewayResourceType = rt({
  name: "Internet Gateway",
  pinnable: false,
  id: "internet-gateway",
  description: "An AWS VPC internet gateway",
  fields: [
    f("internetGatewayId", "Gateway ID"),
    f("vpcId", "Attached VPC", { required: false }),
    f("state", "State", { required: false }),
  ],
  outputs: [],
  iconKey: "network",
  supportsCreate: true,
  attachTargets: [
    { pluginId: "aws", resourceTypeId: "vpc", verb: "Attach" },
    { pluginId: "aws", resourceTypeId: "route-table", verb: "Add default route" },
  ],
});
