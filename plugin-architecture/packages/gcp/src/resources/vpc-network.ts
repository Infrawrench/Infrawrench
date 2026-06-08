import { f, o, rt } from "@infrawrench/plugin-base";

export const VpcNetworkResourceType = rt({
  name: "VPC Network",
  pinnable: false,
  id: "vpc-network",
  description: "A Google Cloud VPC network",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("autoCreateSubnetworks", "Auto Subnets", { kind: "boolean", required: false }),
    f("mtu", "MTU", { kind: "number", required: false }),
    f("subnetCount", "Subnet Count", { kind: "number", required: false }),
  ],
  outputs: [o("selfLink", "Self Link")],
  supportsCreate: true,
});
