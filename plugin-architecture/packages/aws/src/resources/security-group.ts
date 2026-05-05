import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const SecurityGroupResourceType: ResourceTypeDefinition = {
  id: "security-group",
  displayName: "Security Group",
  pluralDisplayName: "Security Groups",
  description: "An AWS EC2 security group (virtual firewall)",
  fields: [
    { key: "groupId", label: "Group ID", kind: "string", required: true },
    { key: "groupName", label: "Group Name", kind: "string", required: true },
    { key: "description", label: "Description", kind: "string", required: false },
    { key: "vpcId", label: "VPC ID", kind: "string", required: true },
    { key: "inboundRuleCount", label: "Inbound Rules", kind: "number", required: false },
    { key: "outboundRuleCount", label: "Outbound Rules", kind: "number", required: false },
  ],
  outputs: [{ key: "groupId", label: "Security Group ID", sensitive: false }],
  dashboardPinnable: false,
  iconKey: "firewall",
  supportsCreate: true,
  attachTargets: [{ pluginId: "aws", resourceTypeId: "ec2-instance", verb: "Apply firewall" }],
};
