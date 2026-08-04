import { f, o, rt } from "@infrawrench/plugin-base";

export const EC2InstanceResourceType = rt({
  name: "EC2 Instance",
  id: "ec2-instance",
  description: "An Amazon EC2 virtual machine instance",
  fields: [
    // EC2 "names" are tags the lister derives; the only editable field is
    // instanceType (the right-sizing resize path).
    f("name", "Name", { required: false, editable: false }),
    f("instanceId", "Instance ID", { editable: false }),
    f("instanceType", "Instance Type", {
      description:
        "Instance type, e.g. t4g.small. Changing it resizes the instance (ModifyInstanceAttribute; only allowed while it is stopped)",
    }),
    f("availabilityZone", "Availability Zone", { editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("state", "State", {
      editable: false,
      kind: "enum",
      enumValues: ["pending", "running", "shutting-down", "terminated", "stopping", "stopped"],
    }),
    f("imageId", "AMI ID", { required: false, editable: false }),
    f("vpcId", "VPC ID", { required: false, editable: false }),
    f("subnetId", "Subnet ID", { required: false, editable: false }),
    f("securityGroupIds", "Security Groups", {
      required: false,
      description: "Comma-separated list of security group IDs attached to the instance",
      editable: false,
    }),
    f("sshAccess", "SSH Access", {
      required: false,
      description:
        "Whether TCP/22 is reachable per the attached security groups. If this says SSH will time out, open port 22 in one of the security groups (commonly from your office/VPN CIDR or 0.0.0.0/0 for dev).",
      editable: false,
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
  // Sleep/wake schedules: StartInstances / StopInstances. A stopped instance
  // stops compute billing (EBS volumes and Elastic IPs keep billing).
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "state",
    runningValues: ["running", "pending"],
    stoppedValues: ["stopped", "stopping"],
  },
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
  // Edit = change instance type only.
  supportsUpdate: true,
  // Right-sizing: the create form's curated size list carries capacity;
  // prices hydrate per region through getCreateSizePricing (Price List Query
  // API — needs pricing:GetProducts). CloudWatch has no agentless memory
  // metric for EC2, so the host's unmeasured-memory floor applies.
  rightsizing: {
    sizeFieldKey: "instanceType",
    regionFieldKey: "region",
    cpuMetric: { seriesLabel: "CPUUtilization" },
    // Family before the dot — t4g (arm) vs t3 (Intel) vs t3a (AMD) stay
    // apart, which ModifyInstanceAttribute can't cross without new drivers.
    sizeFamilyPattern: "^([a-z0-9-]+)\\.",
    resizeNote:
      "EC2 only changes the instance type of a stopped instance — stop it first, apply the resize, then start it again.",
  },
  // The lister precomputes `sshAccess` from a DescribeSecurityGroups pass, so
  // the world-open case is an exact stored string, not a CIDR parse.
  postureChecks: [
    {
      id: "ec2-ssh-world-open",
      title: "SSH open to the world",
      severity: "high",
      category: "public-exposure",
      conditions: [
        {
          fieldKey: "sshAccess",
          when: "equals",
          value: "Port 22 open to the world (0.0.0.0/0).",
        },
      ],
      reason:
        "An attached security group allows inbound TCP/22 from 0.0.0.0/0, so anyone on the internet can attempt SSH logins against this instance.",
    },
  ],
});
