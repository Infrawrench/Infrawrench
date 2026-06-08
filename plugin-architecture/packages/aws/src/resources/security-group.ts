import { f, o, rt } from "@infrawrench/plugin-base";

export const SecurityGroupResourceType = rt({
  name: "Security Group",
  pinnable: false,
  id: "security-group",
  description: "An AWS EC2 security group (virtual firewall)",
  fields: [
    f("groupId", "Group ID"),
    f("groupName", "Group Name"),
    f("description", "Description", { required: false }),
    f("vpcId", "VPC ID"),
    f("inboundRuleCount", "Inbound Rules", { kind: "number", required: false }),
    f("outboundRuleCount", "Outbound Rules", { kind: "number", required: false }),
  ],
  outputs: [o("groupId", "Security Group ID")],
  iconKey: "firewall",
  supportsCreate: true,
  attachTargets: [{ pluginId: "aws", resourceTypeId: "ec2-instance", verb: "Apply firewall" }],
});
