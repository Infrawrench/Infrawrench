import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

export const EC2InstanceResourceType: ResourceTypeDefinition = {
  id: "ec2-instance",
  displayName: "EC2 Instance",
  pluralDisplayName: "EC2 Instances",
  description: "An Amazon EC2 virtual machine instance",
  fields: [
    { key: "name", label: "Name", kind: "string", required: false },
    { key: "instanceId", label: "Instance ID", kind: "string", required: true },
    { key: "instanceType", label: "Instance Type", kind: "string", required: true },
    { key: "availabilityZone", label: "Availability Zone", kind: "string", required: true },
    {
      key: "state",
      label: "State",
      kind: "enum",
      required: true,
      enumValues: ["pending", "running", "shutting-down", "terminated", "stopping", "stopped"],
    },
    { key: "imageId", label: "AMI ID", kind: "string", required: false },
    { key: "vpcId", label: "VPC ID", kind: "string", required: false },
    { key: "subnetId", label: "Subnet ID", kind: "string", required: false },
    {
      key: "securityGroupIds",
      label: "Security Groups",
      kind: "string",
      required: false,
      description: "Comma-separated list of security group IDs attached to the instance",
    },
    {
      key: "sshAccess",
      label: "SSH Access",
      kind: "string",
      required: false,
      description:
        "Whether TCP/22 is reachable per the attached security groups. If this says SSH will time out, open port 22 in one of the security groups (commonly from your office/VPN CIDR or 0.0.0.0/0 for dev).",
    },
    {
      key: "network",
      label: "VPC Network",
      kind: "association",
      required: false,
      description: "VPC network to attach the instance to",
      allowLiteral: true,
      resolvableOutputKeys: ["vpcId"],
      resolvableFrom: [
        {
          pluginId: "aws",
          resourceTypeId: "vpc",
          outputKey: "vpcId",
        },
      ],
    },
  ],
  outputs: [
    { key: "publicIp", label: "Public IP", sensitive: false },
    { key: "privateIp", label: "Private IP", sensitive: false },
    { key: "publicDns", label: "Public DNS", sensitive: false },
  ],
  dashboardPinnable: true,
  supportsMetrics: true,
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "state", value: "running" },
    usernameFieldKey: "sshUsername",
  },
  supportsCreate: true,
};
