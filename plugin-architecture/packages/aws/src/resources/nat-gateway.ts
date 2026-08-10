import { f, o, rt } from "@infrawrench/plugin-base";

export const NATGatewayResourceType = rt({
  name: "NAT Gateway",
  id: "nat-gateway",
  description: "An AWS VPC NAT gateway",
  fields: [
    f("natGatewayId", "NAT Gateway ID"),
    f("state", "State", {
      kind: "enum",
      enumValues: ["pending", "failed", "available", "deleting", "deleted"],
    }),
    f("subnetId", "Subnet ID", { required: false }),
    f("vpcId", "VPC ID", { required: false }),
    f("connectivityType", "Connectivity", {
      kind: "enum",
      required: false,
      enumValues: ["public", "private"],
    }),
    f("publicIp", "Public IP", { required: false }),
    f("privateIp", "Private IP", { required: false }),
  ],
  outputs: [o("natGatewayId", "NAT Gateway ID")],
  dependsOn: [
    { fieldKey: "subnetId", targetTypeId: "subnet", label: "in subnet" },
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
    // The gateway's address is an allocated Elastic IP, but an EIP's external
    // id is its allocation id — match the address itself instead.
    { fieldKey: "publicIp", targetTypeId: "elastic-ip", targetKey: "publicIp", label: "uses IP" },
  ],
  iconKey: "network",
  supportsCreate: true,
  supportsMetrics: true,
  attachTargets: [
    {
      pluginId: "aws",
      resourceTypeId: "route-table",
      matchField: "vpcId",
      verb: "Add default route",
    },
  ],
});
