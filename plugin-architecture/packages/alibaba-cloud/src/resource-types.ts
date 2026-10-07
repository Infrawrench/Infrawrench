import { f, o, rt, type ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * Resource types. Regional resources use `{region}/{id}` as the external id
 * (every Alibaba API call needs the region, and `getResource` only receives
 * the id); cross-references are stored as the bare provider id and matched
 * with `{region}/{field}` templates. Exceptions: the account (its numeric
 * id), DNS domains (the domain name), DNS records (`{domain}/{recordId}`),
 * RAM users (the user name), OSS buckets (`{region}/{bucket}`) and ACK node
 * pools (`{region}/{clusterId}/{nodepoolId}`).
 */

const regionField = f("region", "Region", { editable: false });
const zoneField = f("zoneId", "Zone", { required: false, editable: false });
const statusField = f("status", "Status", { required: false, editable: false });
const createdField = f("createdAt", "Created", { required: false, editable: false });
const vpcDep = {
  fieldKey: "vpcId",
  targetTypeId: "vpc",
  matchTemplate: "{region}/{vpcId}",
  label: "in",
} as const;
const vswitchDep = {
  fieldKey: "vswitchId",
  targetTypeId: "vswitch",
  matchTemplate: "{region}/{vswitchId}",
  label: "in",
} as const;

export const AccountResourceType = rt({
  id: "account",
  name: "Account",
  description:
    "The Alibaba Cloud account the AccessKey belongs to: the identity in use, the regions being scanned, the account balance and month-to-date spend",
  fields: [
    f("accountId", "Account ID", { editable: false }),
    f("identity", "Signed In As", { required: false, editable: false }),
    f("identityType", "Identity Type", { required: false, editable: false }),
    f("homeRegion", "Default Region", { required: false, editable: false }),
    f("regions", "Regions Scanned", { required: false, editable: false }),
  ],
  outputs: [o("accountId", "Account ID")],
  iconKey: "account",
  pinnable: true,
  supportsDelete: false,
});

export const EcsInstanceResourceType = rt({
  id: "ecs-instance",
  name: "ECS Instance",
  description: "An Elastic Compute Service virtual machine",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    regionField,
    zoneField,
    f("instanceType", "Instance Type", {
      description:
        "Changing it resizes the instance (ModifyInstanceSpec for pay-as-you-go, ModifyPrepayInstanceSpec for subscription). Most types need the instance stopped first.",
    }),
    f("instanceTypeFamily", "Type Family", { required: false, editable: false }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("memoryGb", "Memory (GB)", { kind: "number", required: false, editable: false }),
    f("gpus", "GPUs", { kind: "number", required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["Pending", "Running", "Starting", "Stopping", "Stopped"],
    }),
    f("stoppedMode", "Stopped Mode", {
      required: false,
      editable: false,
      description:
        "StopCharging releases vCPUs and memory while stopped (pay-as-you-go in a VPC); KeepCharging keeps billing compute",
    }),
    f("osName", "Operating System", { required: false, editable: false }),
    f("imageId", "Image", { required: false, editable: false }),
    f("vpcId", "VPC", { required: false, editable: false }),
    f("vswitchId", "vSwitch", { required: false, editable: false }),
    f("securityGroupIds", "Security Groups", { required: false, editable: false }),
    f("keyPairName", "Key Pair", { required: false, editable: false }),
    f("chargeType", "Billing", {
      required: false,
      editable: false,
      description: "PostPaid is pay-as-you-go, PrePaid is subscription",
    }),
    f("internetMaxBandwidthOut", "Public Bandwidth (Mbps)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("expiredTime", "Subscription Ends", { required: false, editable: false }),
    f("sshUsername", "SSH Username", { required: false, editable: false }),
    createdField,
  ],
  outputs: [o("publicIp", "Public IP"), o("privateIp", "Private IP"), o("id", "Instance ID")],
  dependsOn: [
    vpcDep,
    vswitchDep,
    {
      fieldKey: "securityGroupIds",
      targetTypeId: "security-group",
      matchTemplate: "{region}/{securityGroupIds}",
      label: "protected by",
    },
  ],
  iconKey: "instance",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "status",
    runningValues: ["Running", "Starting"],
    stoppedValues: ["Stopped", "Stopping"],
  },
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "status", value: "Running" },
    defaultUsername: "root",
    usernameFieldKey: "sshUsername",
  },
  rightsizing: {
    sizeFieldKey: "instanceType",
    regionFieldKey: "region",
    createSizeFieldKey: "instanceType",
    cpuMetric: { seriesLabel: "CPU Utilization" },
    memoryMetric: { seriesLabel: "Memory Utilization", interpretation: "percent" },
    // ecs.g7.large stays in ecs.g7: crossing families changes the CPU vendor
    // or architecture, which can need a different image.
    sizeFamilyPattern: "^(ecs\\.[a-z0-9-]+)\\.",
    resizeNote:
      "Pay-as-you-go instances must be stopped to change most instance types; ECS restarts nothing on its own, so start the instance again afterwards.",
  },
  carbon: {
    regionFieldKey: "region",
    vcpus: { from: "field", fieldKey: "vcpus" },
  },
  orphanRule: {
    conditions: [
      { fieldKey: "status", when: "equals", value: "Stopped" },
      { fieldKey: "stoppedMode", when: "notEquals", value: "StopCharging" },
    ],
    reason:
      "Instance is stopped but still billed for compute (subscription, or stopped in KeepCharging mode), and its disks keep billing either way.",
  },
});

export const DiskResourceType = rt({
  id: "disk",
  name: "Disk",
  description: "An ECS block storage disk (cloud disk or ESSD)",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    regionField,
    zoneField,
    f("sizeGb", "Size (GB)", {
      kind: "number",
      description: "Disks can only grow. A disk attached to a running instance is resized online.",
    }),
    f("category", "Category", { required: false, editable: false }),
    f("performanceLevel", "Performance Level", { required: false, editable: false }),
    f("diskType", "Role", {
      kind: "enum",
      enumValues: ["system", "data"],
      required: false,
      editable: false,
    }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["In_use", "Available", "Attaching", "Detaching", "Creating", "ReIniting"],
    }),
    f("instanceId", "Attached Instance", { required: false, editable: false }),
    f("deleteWithInstance", "Delete With Instance", { kind: "boolean", required: false }),
    f("encrypted", "Encrypted", { kind: "boolean", required: false, editable: false }),
    f("chargeType", "Billing", { required: false, editable: false }),
    createdField,
  ],
  outputs: [o("id", "Disk ID")],
  dependsOn: [
    {
      fieldKey: "instanceId",
      targetTypeId: "ecs-instance",
      matchTemplate: "{region}/{instanceId}",
      label: "attached to",
    },
  ],
  iconKey: "volume",
  supportsCreate: true,
  supportsUpdate: true,
  attachTargets: [
    {
      pluginId: "alibaba-cloud",
      resourceTypeId: "ecs-instance",
      matchField: "zoneId",
      verb: "Attach",
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "Available" }],
    reason: "Disk is not attached to any instance and keeps billing per GB",
  },
});

export const SnapshotResourceType = rt({
  id: "snapshot",
  name: "Snapshot",
  description: "A point-in-time snapshot of an ECS disk",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    regionField,
    f("sourceDiskId", "Source Disk", { required: false, editable: false }),
    f("sizeGb", "Source Disk Size (GB)", { kind: "number", required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("progress", "Progress", { required: false, editable: false }),
    f("retentionDays", "Retention (days)", {
      kind: "number",
      required: false,
      description: "Days to keep the snapshot before Alibaba deletes it. Empty keeps it forever.",
    }),
    f("snapshotType", "Type", { required: false, editable: false }),
    createdField,
  ],
  outputs: [o("id", "Snapshot ID")],
  dependsOn: [
    {
      fieldKey: "sourceDiskId",
      targetTypeId: "disk",
      matchTemplate: "{region}/{sourceDiskId}",
      label: "of",
    },
  ],
  iconKey: "snapshot",
  supportsCreate: true,
  supportsUpdate: true,
  backupRole: { role: "snapshot", sourceTemplate: "{region}/{sourceDiskId}" },
});

export const VpcResourceType = rt({
  id: "vpc",
  name: "VPC",
  plural: "VPCs",
  description: "A Virtual Private Cloud",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    regionField,
    f("cidrBlock", "CIDR Block", { editable: false }),
    f("isDefault", "Default VPC", { kind: "boolean", required: false, editable: false }),
    f("vswitchCount", "vSwitches", { kind: "number", required: false, editable: false }),
    statusField,
    createdField,
  ],
  outputs: [o("id", "VPC ID")],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

export const VSwitchResourceType = rt({
  id: "vswitch",
  name: "vSwitch",
  description: "A zonal subnet inside a VPC",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    regionField,
    zoneField,
    f("vpcId", "VPC", { editable: false }),
    f("cidrBlock", "CIDR Block", { editable: false }),
    f("availableIps", "Free IPs", { kind: "number", required: false, editable: false }),
    statusField,
    createdField,
  ],
  outputs: [o("id", "vSwitch ID")],
  dependsOn: [vpcDep],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

export const SecurityGroupResourceType = rt({
  id: "security-group",
  name: "Security Group",
  description: "A stateful firewall for ECS instances",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    regionField,
    f("vpcId", "VPC", { required: false, editable: false }),
    f("groupType", "Type", { required: false, editable: false }),
    f("ingressRules", "Ingress Rules", { required: false, editable: false }),
    f("ruleCount", "Rules", { kind: "number", required: false, editable: false }),
    f("instanceCount", "Instances", { kind: "number", required: false, editable: false }),
    f("internetOpenPorts", "Ports Open to the Internet", {
      required: false,
      editable: false,
      description:
        "Ports an accept rule opens to 0.0.0.0/0 (all when a rule allows every port or protocol)",
    }),
    f("adminPortsOpen", "SSH/RDP Open to the Internet", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    createdField,
  ],
  outputs: [o("id", "Security Group ID")],
  dependsOn: [vpcDep],
  iconKey: "firewall",
  supportsCreate: true,
  supportsUpdate: true,
  postureChecks: [
    {
      id: "alibaba-security-group-admin-ports-open",
      title: "SSH or RDP open to the internet",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "adminPortsOpen", when: "truthy" }],
      reason:
        "An inbound accept rule lets 0.0.0.0/0 reach SSH (22) or RDP (3389) on every instance in this group.",
    },
  ],
});

export const EipResourceType = rt({
  id: "eip",
  name: "Elastic IP",
  description: "An Elastic IP Address",
  fields: [
    f("name", "Name"),
    regionField,
    f("ipAddress", "IP Address", { editable: false }),
    f("bandwidthMbps", "Bandwidth (Mbps)", { kind: "number", description: "Peak bandwidth" }),
    f("status", "Status", {
      required: false,
      editable: false,
      description: "Available means allocated but not associated with anything",
    }),
    f("instanceId", "Associated With", { required: false, editable: false }),
    f("instanceType", "Associated Type", { required: false, editable: false }),
    f("internetChargeType", "Metering", { required: false, editable: false }),
    f("chargeType", "Billing", { required: false, editable: false }),
    createdField,
  ],
  outputs: [o("ipAddress", "IP Address"), o("id", "Allocation ID")],
  dependsOn: [
    {
      fieldKey: "instanceId",
      targetTypeId: "ecs-instance",
      matchTemplate: "{region}/{instanceId}",
      label: "attached to",
    },
  ],
  iconKey: "ip",
  supportsCreate: true,
  supportsUpdate: true,
  attachTargets: [
    {
      pluginId: "alibaba-cloud",
      resourceTypeId: "ecs-instance",
      matchField: "region",
      verb: "Associate",
    },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "Available" }],
    reason: "Elastic IP is not associated with anything and keeps billing an idle-address fee",
  },
});

export const SlbResourceType = rt({
  id: "slb",
  name: "Classic Load Balancer",
  description: "A Server Load Balancer (CLB) instance",
  fields: [
    f("name", "Name"),
    regionField,
    f("address", "Address", { editable: false }),
    f("addressType", "Address Type", {
      kind: "enum",
      enumValues: ["internet", "intranet"],
      editable: false,
    }),
    f("spec", "Specification", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["active", "inactive", "locked"],
      required: false,
      editable: false,
    }),
    f("vpcId", "VPC", { required: false, editable: false }),
    f("vswitchId", "vSwitch", { required: false, editable: false }),
    f("bandwidthMbps", "Bandwidth (Mbps)", { kind: "number", required: false, editable: false }),
    f("internetChargeType", "Metering", { required: false, editable: false }),
    f("chargeType", "Billing", { required: false, editable: false }),
    f("masterZoneId", "Primary Zone", { required: false, editable: false }),
    createdField,
  ],
  outputs: [o("address", "Address"), o("id", "Load Balancer ID")],
  dependsOn: [vpcDep, vswitchDep],
  iconKey: "load-balancer",
  supportsUpdate: true,
  supportsMetrics: true,
  lifecycle: {
    startActionId: "activate",
    stopActionId: "deactivate",
    statusFieldKey: "status",
    runningValues: ["active"],
    stoppedValues: ["inactive"],
  },
});

export const AlbResourceType = rt({
  id: "alb",
  name: "Application Load Balancer",
  description: "An Application Load Balancer (ALB) instance",
  fields: [
    f("name", "Name"),
    regionField,
    f("dnsName", "DNS Name", { editable: false }),
    f("addressType", "Address Type", { required: false, editable: false }),
    f("edition", "Edition", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("businessStatus", "Business Status", { required: false, editable: false }),
    f("vpcId", "VPC", { required: false, editable: false }),
    f("payType", "Billing", { required: false, editable: false }),
    createdField,
  ],
  outputs: [o("dnsName", "DNS Name"), o("id", "Load Balancer ID")],
  dependsOn: [vpcDep],
  iconKey: "load-balancer",
  supportsUpdate: true,
  supportsMetrics: true,
});

export const RdsInstanceResourceType = rt({
  id: "rds-instance",
  name: "ApsaraDB RDS Instance",
  description: "A managed MySQL, PostgreSQL, SQL Server or MariaDB instance",
  fields: [
    f("name", "Description"),
    regionField,
    zoneField,
    f("engine", "Engine", { editable: false }),
    f("engineVersion", "Engine Version", { editable: false }),
    f("instanceClass", "Instance Class", {
      description: "Changing it scales the instance; RDS switches over once the new spec is ready",
    }),
    f("storageGb", "Storage (GB)", { kind: "number", required: false }),
    f("storageType", "Storage Type", { required: false, editable: false }),
    f("category", "Edition", { required: false, editable: false }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("memoryMb", "Memory (MB)", { kind: "number", required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("payType", "Billing", { required: false, editable: false }),
    f("vpcId", "VPC", { required: false, editable: false }),
    f("vswitchId", "vSwitch", { required: false, editable: false }),
    f("expireTime", "Subscription Ends", { required: false, editable: false }),
    createdField,
  ],
  outputs: [o("host", "Endpoint"), o("port", "Port"), o("id", "Instance ID")],
  dependsOn: [vpcDep, vswitchDep],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
});

export const RedisInstanceResourceType = rt({
  id: "redis-instance",
  name: "Tair (Redis) Instance",
  description: "An ApsaraDB for Redis / Tair (Redis OSS-compatible) instance",
  fields: [
    f("name", "Name"),
    regionField,
    zoneField,
    f("instanceClass", "Instance Class", {
      description: "Changing it scales the instance online (a brief switchover at the end)",
    }),
    f("capacityMb", "Memory (MB)", { kind: "number", required: false, editable: false }),
    f("engineVersion", "Engine Version", { required: false, editable: false }),
    f("architecture", "Architecture", { required: false, editable: false }),
    f("instanceType", "Engine", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("chargeType", "Billing", { required: false, editable: false }),
    f("vpcId", "VPC", { required: false, editable: false }),
    f("vswitchId", "vSwitch", { required: false, editable: false }),
    createdField,
  ],
  outputs: [o("host", "Endpoint"), o("port", "Port"), o("id", "Instance ID")],
  dependsOn: [vpcDep, vswitchDep],
  iconKey: "cache",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
});

export const OssBucketResourceType = rt({
  id: "oss-bucket",
  name: "OSS Bucket",
  description: "An Object Storage Service bucket",
  fields: [
    f("name", "Name", { editable: false }),
    regionField,
    f("storageClass", "Storage Class", { required: false, editable: false }),
    f("acl", "Access", {
      kind: "enum",
      enumValues: ["private", "public-read", "public-read-write"],
      description:
        "Bucket ACL. public-read lets anyone read objects; public-read-write lets anyone write",
    }),
    f("versioning", "Versioning", {
      kind: "enum",
      enumValues: ["Enabled", "Suspended", "Disabled"],
      required: false,
    }),
    f("redundancyType", "Redundancy", { required: false, editable: false }),
    f("objectCount", "Objects", { kind: "number", required: false, editable: false }),
    f("storageGb", "Stored (GB)", { kind: "number", required: false, editable: false }),
    createdField,
  ],
  outputs: [o("name", "Bucket Name"), o("endpoint", "Endpoint")],
  iconKey: "bucket",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  supportsStorageBrowser: true,
  postureChecks: [
    {
      id: "alibaba-oss-bucket-public",
      title: "Bucket allows public access",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "acl", when: "notEquals", value: "private" }],
      reason:
        "The bucket ACL lets anyone on the internet read objects (and, with public-read-write, write them).",
    },
  ],
});

export const AckClusterResourceType = rt({
  id: "ack-cluster",
  name: "ACK Cluster",
  description: "A Container Service for Kubernetes (ACK) cluster",
  fields: [
    f("name", "Name"),
    regionField,
    f("clusterType", "Cluster Type", { required: false, editable: false }),
    f("clusterSpec", "Edition", { required: false, editable: false }),
    f("kubernetesVersion", "Kubernetes Version", {
      description: "Pick a newer version to upgrade the control plane",
    }),
    f("nextVersion", "Next Version", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    f("vpcId", "VPC", { required: false, editable: false }),
    f("deletionProtection", "Deletion Protection", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    createdField,
  ],
  outputs: [
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Kubeconfig YAML for this cluster (a client certificate, no exec plugin)",
    }),
    o("apiEndpoint", "API Endpoint"),
    o("id", "Cluster ID"),
  ],
  dependsOn: [vpcDep],
  iconKey: "kubernetes",
  supportsUpdate: true,
  credentialFormats: [
    {
      id: "kubeconfig",
      label: "Kubeconfig",
      description: "A kubeconfig for kubectl, valid for three days",
      mediaType: "text",
      filenameTemplate: "{name}-kubeconfig.yaml",
    },
  ],
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
      tabLabel: "Kubernetes",
    },
  ],
});

export const AckNodePoolResourceType = rt({
  id: "ack-node-pool",
  name: "Node Pool",
  description: "A pool of worker nodes in an ACK cluster",
  parentTypeId: "ack-cluster",
  pinnable: false,
  fields: [
    f("name", "Name"),
    regionField,
    f("clusterId", "Cluster", { editable: false }),
    f("desiredSize", "Desired Nodes", {
      kind: "number",
      description: "Scale the pool by changing the desired node count",
    }),
    f("totalNodes", "Nodes", { kind: "number", required: false, editable: false }),
    f("healthyNodes", "Healthy Nodes", { kind: "number", required: false, editable: false }),
    f("instanceTypes", "Instance Types", { required: false, editable: false }),
    f("autoScaling", "Auto Scaling", { kind: "boolean", required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
  ],
  outputs: [o("id", "Node Pool ID")],
  dependsOn: [
    {
      fieldKey: "clusterId",
      targetTypeId: "ack-cluster",
      matchTemplate: "{region}/{clusterId}",
      label: "in",
    },
  ],
  iconKey: "kubernetes",
  supportsUpdate: true,
});

export const FcFunctionResourceType = rt({
  id: "fc-function",
  name: "Function",
  description: "A Function Compute 3.0 function",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false }),
    regionField,
    f("runtime", "Runtime", { required: false, editable: false }),
    f("handler", "Handler", { required: false, editable: false }),
    f("memoryMb", "Memory (MB)", {
      kind: "number",
      description: "64 to 32768 MB, a multiple of 64",
    }),
    f("cpu", "vCPUs", {
      kind: "number",
      required: false,
      description: "0.05 to 16 vCPUs; memory must be 1 to 4 times the vCPUs in GB",
    }),
    f("timeoutSeconds", "Timeout (s)", { kind: "number", required: false }),
    f("state", "State", { required: false, editable: false }),
    f("lastModified", "Last Modified", { required: false, editable: false }),
    createdField,
  ],
  outputs: [o("httpUrl", "HTTP URL"), o("arn", "Function ARN")],
  iconKey: "function",
  supportsUpdate: true,
  supportsMetrics: true,
});

export const DnsDomainResourceType = rt({
  id: "dns-domain",
  name: "DNS Domain",
  description: "A domain hosted on Alibaba Cloud DNS",
  fields: [
    f("name", "Domain", { editable: false }),
    f("recordCount", "Records", { kind: "number", required: false, editable: false }),
    f("nameservers", "Nameservers", { required: false, editable: false }),
    f("edition", "Edition", { required: false, editable: false }),
    f("remark", "Remark", { required: false, editable: false }),
    createdField,
  ],
  outputs: [o("nameservers", "Nameservers"), o("id", "Domain ID")],
  iconKey: "dns",
  supportsCreate: true,
  dnsRole: { role: "zone", domainKey: "name", recordCountKey: "recordCount" },
});

export const DnsRecordResourceType = rt({
  id: "dns-record",
  name: "DNS Record",
  description: "A record in an Alibaba Cloud DNS domain",
  parentTypeId: "dns-domain",
  pinnable: false,
  fields: [
    f("name", "Host", { description: "Relative to the domain; @ is the apex" }),
    f("type", "Type", {
      kind: "enum",
      enumValues: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"],
    }),
    f("content", "Value"),
    f("ttl", "TTL", { kind: "number", required: false, description: "Seconds (600 by default)" }),
    f("priority", "Priority", { kind: "number", required: false, description: "MX only, 1 to 50" }),
    f("line", "Line", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["ENABLE", "DISABLE"],
      required: false,
      editable: false,
    }),
    f("domain", "Domain", { editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "domain", targetTypeId: "dns-domain", label: "in domain" }],
  dnsRole: { role: "record", zoneKey: "domain", priorityKey: "priority" },
  iconKey: "dns-record",
  supportsCreate: true,
  supportsUpdate: true,
});

export const RamUserResourceType = rt({
  id: "ram-user",
  name: "RAM User",
  description: "A Resource Access Management user",
  fields: [
    f("name", "User Name", { editable: false }),
    f("displayName", "Display Name"),
    f("email", "Email", { required: false }),
    f("comments", "Comments", { required: false }),
    f("userId", "User ID", { required: false, editable: false }),
    f("accessKeys", "Access Keys", { required: false, editable: false }),
    f("activeKeyCount", "Active Keys", { kind: "number", required: false, editable: false }),
    f("policies", "Policies", { required: false, editable: false }),
    f("isAdmin", "Administrator", {
      kind: "boolean",
      required: false,
      editable: false,
      description: "Has the AdministratorAccess system policy attached directly",
    }),
    f("lastLoginAt", "Last Console Login", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("userId", "User ID")],
  iconKey: "user",
  supportsCreate: true,
  supportsUpdate: true,
  principalRole: {
    role: "user",
    lastUsedKey: "lastLoginAt",
    createdKey: "createdAt",
    adminIndicatorKey: "isAdmin",
  },
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  EcsInstanceResourceType,
  DiskResourceType,
  SnapshotResourceType,
  VpcResourceType,
  VSwitchResourceType,
  SecurityGroupResourceType,
  EipResourceType,
  SlbResourceType,
  AlbResourceType,
  RdsInstanceResourceType,
  RedisInstanceResourceType,
  OssBucketResourceType,
  AckClusterResourceType,
  AckNodePoolResourceType,
  FcFunctionResourceType,
  DnsDomainResourceType,
  DnsRecordResourceType,
  RamUserResourceType,
];
