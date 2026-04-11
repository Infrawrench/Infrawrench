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
    runningWhen: { fieldKey: "state", value: "running" },
  },
  supportsCreate: true,
};
