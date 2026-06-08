import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const InternetGatewayResourceType: ResourceTypeDefinition = {
  id: "internet-gateway",
  displayName: "Internet Gateway",
  pluralDisplayName: "Internet Gateways",
  description: "An AWS VPC internet gateway",
  fields: [
    { key: "internetGatewayId", label: "Gateway ID", kind: "string", required: true },
    { key: "vpcId", label: "Attached VPC", kind: "string", required: false },
    { key: "state", label: "State", kind: "string", required: false },
  ],
  outputs: [],
  dashboardPinnable: false,
  iconKey: "network",
  supportsCreate: true,
  attachTargets: [{ pluginId: "aws", resourceTypeId: "vpc", verb: "Attach" }],
};
