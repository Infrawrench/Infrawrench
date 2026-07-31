import { f, o, rt } from "@infrawrench/plugin-base";

export const DBSubnetGroupResourceType = rt({
  name: "DB Subnet Group",
  id: "db-subnet-group",
  description: "An RDS DB subnet group — the VPC subnets an RDS-family cluster or instance runs in",
  fields: [
    f("name", "Name"),
    f("region", "Region", { required: false }),
    f("vpcId", "VPC ID"),
    f("subnetIds", "Subnets", {
      required: false,
      description: "Comma-separated subnet IDs that make up the group",
    }),
    f("status", "Status", { required: false }),
    f("description", "Description", { required: false }),
  ],
  outputs: [o("subnetGroupArn", "Subnet Group ARN")],
  // The group is the join between an RDS-family database and its network
  // placement: it names one VPC and the subnets within it.
  dependsOn: [
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
    { fieldKey: "subnetIds", targetTypeId: "subnet", label: "spans" },
  ],
  iconKey: "network",
});
