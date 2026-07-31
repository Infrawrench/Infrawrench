import { f, o, rt } from "@infrawrench/plugin-base";

export const SubnetResourceType = rt({
  name: "Subnet",
  pinnable: false,
  id: "subnet",
  description: "An AWS VPC subnet",
  parentTypeId: "vpc",
  fields: [
    f("subnetId", "Subnet ID"),
    f("name", "Name", { required: false }),
    f("vpcId", "VPC ID"),
    f("cidrBlock", "CIDR Block"),
    f("availabilityZone", "Availability Zone"),
    f("state", "State"),
    f("availableIps", "Available IPs", { kind: "number", required: false }),
    f("mapPublicIp", "Map Public IP", { kind: "boolean", required: false }),
  ],
  outputs: [o("subnetArn", "Subnet ARN")],
  dependsOn: [{ fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" }],
  iconKey: "network",
  supportsCreate: true,
});
