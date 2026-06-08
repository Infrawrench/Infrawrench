import { f, o, rt } from "@infrawrench/plugin-base";

export const VPCResourceType = rt({
  name: "VPC",
  id: "vpc",
  description: "An Amazon Virtual Private Cloud network",
  fields: [
    f("vpcId", "VPC ID"),
    f("name", "Name", { required: false }),
    f("cidrBlock", "CIDR Block"),
    f("state", "State"),
    f("isDefault", "Default VPC", { kind: "boolean", required: false }),
    f("tenancy", "Tenancy", { required: false }),
  ],
  outputs: [o("vpcId", "VPC ID")],
  iconKey: "network",
  supportsCreate: true,
});
