import { f, o, rt } from "@infrawrench/plugin-base";

export const EC2InstanceResourceType = rt({
  name: "EC2 Instance",
  id: "ec2-instance",
  description: "An Amazon EC2 virtual machine instance",
  fields: [
    f("name", "Name", { required: false }),
    f("instanceId", "Instance ID"),
    f("instanceType", "Instance Type"),
    f("availabilityZone", "Availability Zone"),
    f("state", "State", {
      kind: "enum",
      enumValues: ["pending", "running", "shutting-down", "terminated", "stopping", "stopped"],
    }),
    f("imageId", "AMI ID", { required: false }),
    f("vpcId", "VPC ID", { required: false }),
    f("subnetId", "Subnet ID", { required: false }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      description: "Comma-separated list of security group IDs attached to the instance",
    }),
    f("sshAccess", "SSH Access", {
      required: false,
      description:
        "Whether TCP/22 is reachable per the attached security groups. If this says SSH will time out, open port 22 in one of the security groups (commonly from your office/VPN CIDR or 0.0.0.0/0 for dev).",
    }),
    f("network", "VPC Network", {
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
    }),
  ],
  outputs: [o("publicIp", "Public IP"), o("privateIp", "Private IP"), o("publicDns", "Public DNS")],
  // Dependency-graph edges. The host can guess `vpc-…` ids on its own, but
  // saying which type each field points at makes the edge exact and lets it
  // survive an id that some other resource also mentions.
  dependsOn: [
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in VPC" },
    { fieldKey: "subnetId", targetTypeId: "subnet", label: "in subnet" },
    // Comma-separated list — one edge per group.
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "guarded by" },
  ],
  supportsMetrics: true,
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "state", value: "running" },
    usernameFieldKey: "sshUsername",
  },
  agentVm: {
    sshKeyFieldKey: "sshKey",
    defaultUsername: "ubuntu",
    defaultFields: {
      instanceType: "t3.small",
      diskSizeGb: "40",
      imageId: "ubuntu-2404",
      // Agent VMs are created without a security-group pick, which lands them
      // in the default group where TCP/22 is typically closed. This makes the
      // create handler attach a shared find-or-create SG with port 22 open.
      openSshPort: "true",
    },
    linuxImageDefaults: { imageId: "ubuntu-2404" },
    hiddenFieldKeys: ["sshKey"],
  },
  supportsCreate: true,
});
