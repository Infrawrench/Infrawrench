import { f, o, rt, type ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * Resource types. VPC resources use `{region}/{id}` as the external id (the
 * VPC API is regional and `getResource` receives only the id); Kubernetes
 * clusters use the cluster id (the API is global), worker pools
 * `{clusterId}/{poolId}`, Code Engine projects `{region}/{projectId}` and
 * apps `{region}/{projectId}/{name}`, COS buckets `{location}/{bucket}`,
 * databases and other service instances their CRN, resource groups their id.
 */

const regionField = f("region", "Region", { editable: false });
const zoneField = f("zone", "Zone", { required: false, editable: false });
const statusField = f("status", "Status", { required: false, editable: false });
const createdField = f("createdAt", "Created", { required: false, editable: false });
const resourceGroupField = f("resourceGroupId", "Resource Group", {
  required: false,
  editable: false,
});
const rgDep = {
  fieldKey: "resourceGroupId",
  targetTypeId: "resource-group",
  label: "in",
} as const;
const vpcDep = {
  fieldKey: "vpcId",
  targetTypeId: "vpc",
  matchTemplate: "{region}/{vpcId}",
  label: "in",
} as const;

export const AccountResourceType = rt({
  id: "account",
  name: "Account",
  description:
    "The IBM Cloud account the API key belongs to: the identity in use, the regions scanned, billable spend this month and promotional credit",
  fields: [
    f("accountId", "Account ID", { editable: false }),
    f("identity", "API Key Owner", { required: false, editable: false }),
    f("homeRegion", "Default Region", { required: false, editable: false }),
    f("regions", "Regions Scanned", { required: false, editable: false }),
  ],
  outputs: [o("accountId", "Account ID")],
  iconKey: "account",
  pinnable: true,
  supportsDelete: false,
});

export const ResourceGroupResourceType = rt({
  id: "resource-group",
  name: "Resource Group",
  description: "An IBM Cloud resource group: the unit access, billing and quotas are organised by",
  fields: [
    f("name", "Name"),
    f("isDefault", "Default", { kind: "boolean", required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    createdField,
  ],
  outputs: [o("id", "Resource Group ID")],
  iconKey: "folder",
  supportsCreate: true,
  supportsUpdate: true,
});

export const InstanceResourceType = rt({
  id: "instance",
  name: "Virtual Server",
  description: "A Virtual Server for VPC instance",
  fields: [
    f("name", "Name"),
    regionField,
    zoneField,
    f("profile", "Profile", {
      description:
        "Changing it resizes the server. IBM Cloud only allows it while the server is stopped.",
    }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("memoryGb", "Memory (GB)", { kind: "number", required: false, editable: false }),
    f("gpus", "GPUs", { kind: "number", required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: [
        "running",
        "stopped",
        "starting",
        "stopping",
        "pending",
        "restarting",
        "deleting",
        "failed",
      ],
    }),
    f("image", "Image", { required: false, editable: false }),
    f("imageId", "Image ID", { required: false, editable: false }),
    f("vpcId", "VPC", { required: false, editable: false }),
    f("subnetId", "Subnet", { required: false, editable: false }),
    f("bootVolumeId", "Boot Volume", { required: false, editable: false }),
    f("sshUsername", "SSH Username", { required: false, editable: false }),
    resourceGroupField,
    createdField,
  ],
  outputs: [o("publicIp", "Floating IP"), o("privateIp", "Private IP"), o("id", "Instance ID")],
  dependsOn: [
    vpcDep,
    {
      fieldKey: "subnetId",
      targetTypeId: "subnet",
      matchTemplate: "{region}/{subnetId}",
      label: "in",
    },
    {
      fieldKey: "bootVolumeId",
      targetTypeId: "volume",
      matchTemplate: "{region}/{bootVolumeId}",
      label: "boots from",
    },
    rgDep,
  ],
  iconKey: "instance",
  supportsCreate: true,
  supportsUpdate: true,
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "status",
    runningValues: ["running", "starting"],
    stoppedValues: ["stopped", "stopping"],
  },
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "status", value: "running" },
    defaultUsername: "root",
    usernameFieldKey: "sshUsername",
  },
  carbon: { regionFieldKey: "region", vcpus: { from: "field", fieldKey: "vcpus" } },
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "stopped" }],
    reason:
      "Server is stopped. IBM Cloud stops billing vCPU and memory for most profiles, but its volumes and floating IPs keep billing, and GPU and dedicated-host capacity can stay reserved.",
  },
});

export const VolumeResourceType = rt({
  id: "volume",
  name: "Block Storage Volume",
  description: "A Block Storage for VPC volume",
  fields: [
    f("name", "Name"),
    regionField,
    zoneField,
    f("capacityGb", "Capacity (GB)", {
      kind: "number",
      description: "Volumes can only grow; an attached data volume grows online",
    }),
    f("profile", "Profile", { required: false, editable: false }),
    f("iops", "IOPS", { kind: "number", required: false, editable: false }),
    statusField,
    f("attachmentState", "Attachment", { required: false, editable: false }),
    f("attachedTo", "Attached To", { required: false, editable: false }),
    resourceGroupField,
    createdField,
  ],
  outputs: [o("id", "Volume ID")],
  dependsOn: [
    {
      fieldKey: "attachedTo",
      targetTypeId: "instance",
      matchTemplate: "{region}/{attachedTo}",
      label: "attached to",
    },
    rgDep,
  ],
  iconKey: "volume",
  supportsCreate: true,
  supportsUpdate: true,
  attachTargets: [
    { pluginId: "ibm-cloud", resourceTypeId: "instance", matchField: "zone", verb: "Attach" },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "attachmentState", when: "equals", value: "unattached" }],
    reason: "Volume is not attached to any server and keeps billing per GB",
  },
});

export const VpcResourceType = rt({
  id: "vpc",
  name: "VPC",
  plural: "VPCs",
  description: "A Virtual Private Cloud",
  fields: [
    f("name", "Name"),
    regionField,
    statusField,
    f("classicAccess", "Classic Access", { kind: "boolean", required: false, editable: false }),
    f("defaultSecurityGroupId", "Default Security Group", { required: false, editable: false }),
    resourceGroupField,
    createdField,
  ],
  outputs: [o("id", "VPC ID")],
  dependsOn: [rgDep],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

export const SubnetResourceType = rt({
  id: "subnet",
  name: "Subnet",
  description: "A zonal subnet in a VPC",
  fields: [
    f("name", "Name"),
    regionField,
    zoneField,
    f("vpcId", "VPC", { editable: false }),
    f("cidrBlock", "CIDR Block", { editable: false }),
    f("availableIps", "Free IPs", { kind: "number", required: false, editable: false }),
    f("totalIps", "Total IPs", { kind: "number", required: false, editable: false }),
    f("publicGatewayId", "Public Gateway", { required: false, editable: false }),
    statusField,
    resourceGroupField,
    createdField,
  ],
  outputs: [o("id", "Subnet ID")],
  dependsOn: [vpcDep, rgDep],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

export const SecurityGroupResourceType = rt({
  id: "security-group",
  name: "Security Group",
  description: "A stateful firewall for VPC network interfaces",
  fields: [
    f("name", "Name"),
    regionField,
    f("vpcId", "VPC", { editable: false }),
    f("inboundRules", "Inbound Rules", { required: false, editable: false }),
    f("ruleCount", "Rules", { kind: "number", required: false, editable: false }),
    f("targetCount", "Attached Targets", { kind: "number", required: false, editable: false }),
    f("internetOpenPorts", "Ports Open to the Internet", { required: false, editable: false }),
    f("adminPortsOpen", "SSH/RDP Open to the Internet", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    resourceGroupField,
    createdField,
  ],
  outputs: [o("id", "Security Group ID")],
  dependsOn: [vpcDep, rgDep],
  iconKey: "firewall",
  supportsCreate: true,
  supportsUpdate: true,
  postureChecks: [
    {
      id: "ibm-security-group-admin-ports-open",
      title: "SSH or RDP open to the internet",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "adminPortsOpen", when: "truthy" }],
      reason:
        "An inbound rule lets 0.0.0.0/0 reach SSH (22) or RDP (3389) on everything this group is attached to.",
    },
  ],
});

export const FloatingIpResourceType = rt({
  id: "floating-ip",
  name: "Floating IP",
  description: "A public IPv4 address that can be bound to a network interface",
  fields: [
    f("name", "Name"),
    regionField,
    zoneField,
    f("address", "Address", { editable: false }),
    statusField,
    f("targetName", "Bound To", { required: false, editable: false }),
    f("instanceId", "Server", { required: false, editable: false }),
    resourceGroupField,
    createdField,
  ],
  outputs: [o("address", "Address"), o("id", "Floating IP ID")],
  dependsOn: [
    {
      fieldKey: "instanceId",
      targetTypeId: "instance",
      matchTemplate: "{region}/{instanceId}",
      label: "bound to",
    },
    rgDep,
  ],
  iconKey: "ip",
  supportsCreate: true,
  supportsUpdate: true,
  attachTargets: [
    { pluginId: "ibm-cloud", resourceTypeId: "instance", matchField: "zone", verb: "Bind" },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "targetName", when: "empty" }],
    reason: "Floating IP is not bound to anything and keeps billing",
  },
});

export const LoadBalancerResourceType = rt({
  id: "load-balancer",
  name: "Load Balancer",
  description: "An Application or Network Load Balancer for VPC",
  fields: [
    f("name", "Name"),
    regionField,
    f("hostname", "Hostname", { editable: false }),
    f("profile", "Profile", { required: false, editable: false }),
    f("isPublic", "Public", { kind: "boolean", required: false, editable: false }),
    f("operatingStatus", "Operating Status", { required: false, editable: false }),
    f("status", "Provisioning Status", { required: false, editable: false }),
    f("listenerCount", "Listeners", { kind: "number", required: false, editable: false }),
    f("poolCount", "Pools", { kind: "number", required: false, editable: false }),
    f("subnetIds", "Subnets", { required: false, editable: false }),
    resourceGroupField,
    createdField,
  ],
  outputs: [o("hostname", "Hostname"), o("id", "Load Balancer ID")],
  dependsOn: [
    {
      fieldKey: "subnetIds",
      targetTypeId: "subnet",
      matchTemplate: "{region}/{subnetIds}",
      label: "in",
    },
    rgDep,
  ],
  iconKey: "load-balancer",
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "poolCount", when: "equals", value: "0" }],
    reason: "Load balancer has no pools, so it forwards traffic nowhere while billing hourly",
  },
});

export const SshKeyResourceType = rt({
  id: "ssh-key",
  name: "SSH Key",
  description: "A public SSH key registered with the VPC service in a region",
  fields: [
    f("name", "Name"),
    regionField,
    f("type", "Type", { required: false, editable: false }),
    f("fingerprint", "Fingerprint", { required: false, editable: false }),
    f("length", "Length", { kind: "number", required: false, editable: false }),
    resourceGroupField,
    createdField,
  ],
  outputs: [o("id", "Key ID"), o("fingerprint", "Fingerprint")],
  dependsOn: [rgDep],
  iconKey: "key",
  supportsCreate: true,
  supportsUpdate: true,
});

export const ClusterResourceType = rt({
  id: "kubernetes-cluster",
  name: "Kubernetes Cluster",
  description: "An IBM Cloud Kubernetes Service or Red Hat OpenShift cluster",
  fields: [
    f("name", "Name", { editable: false }),
    regionField,
    f("type", "Platform", { required: false, editable: false }),
    f("provider", "Infrastructure", { required: false, editable: false }),
    f("version", "Version", {
      description:
        "The master version, for example 1.33 (Kubernetes) or 4.18_openshift. Pick a newer one to update the master; workers are updated separately.",
    }),
    f("targetVersion", "Target Version", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("workerCount", "Workers", { kind: "number", required: false, editable: false }),
    f("versionEndOfSupport", "Version End of Support", { required: false, editable: false }),
    resourceGroupField,
    createdField,
  ],
  outputs: [o("masterUrl", "Master URL"), o("id", "Cluster ID")],
  dependsOn: [rgDep],
  iconKey: "kubernetes",
  supportsUpdate: true,
});

export const WorkerPoolResourceType = rt({
  id: "worker-pool",
  name: "Worker Pool",
  description: "A pool of worker nodes in a Kubernetes or OpenShift cluster",
  parentTypeId: "kubernetes-cluster",
  pinnable: false,
  fields: [
    f("name", "Name", { editable: false }),
    f("clusterId", "Cluster", { editable: false }),
    f("flavor", "Flavor", { required: false, editable: false }),
    f("sizePerZone", "Workers per Zone", {
      kind: "number",
      description: "Resize the pool by changing the number of workers in each zone",
    }),
    f("zones", "Zones", { required: false, editable: false }),
    f("workerCount", "Workers", { kind: "number", required: false, editable: false }),
    f("autoscale", "Autoscaling", { kind: "boolean", required: false, editable: false }),
    f("operatingSystem", "Operating System", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
  ],
  outputs: [o("id", "Worker Pool ID")],
  dependsOn: [{ fieldKey: "clusterId", targetTypeId: "kubernetes-cluster", label: "in" }],
  iconKey: "kubernetes",
  supportsUpdate: true,
});

export const CodeEngineProjectResourceType = rt({
  id: "code-engine-project",
  name: "Code Engine Project",
  description: "A Code Engine project: the namespace apps, jobs and functions run in",
  fields: [
    f("name", "Name", { editable: false }),
    regionField,
    statusField,
    resourceGroupField,
    createdField,
  ],
  outputs: [o("id", "Project ID")],
  dependsOn: [rgDep],
  iconKey: "folder",
  supportsCreate: true,
});

export const CodeEngineAppResourceType = rt({
  id: "code-engine-app",
  name: "Code Engine App",
  description: "A Code Engine application, served from a container image and scaled to zero",
  parentTypeId: "code-engine-project",
  fields: [
    f("name", "Name", { editable: false }),
    regionField,
    f("projectId", "Project", { editable: false }),
    f("image", "Image"),
    f("port", "Port", { kind: "number", required: false }),
    f("minInstances", "Minimum Instances", { kind: "number", required: false }),
    f("maxInstances", "Maximum Instances", { kind: "number", required: false }),
    f("cpu", "vCPUs", { required: false, description: "For example 0.25, 0.5 or 1" }),
    f("memory", "Memory", { required: false, description: "For example 1G or 4G" }),
    statusField,
    createdField,
  ],
  outputs: [o("url", "URL"), o("internalUrl", "Internal URL")],
  dependsOn: [
    {
      fieldKey: "projectId",
      targetTypeId: "code-engine-project",
      matchTemplate: "{region}/{projectId}",
      label: "in",
    },
  ],
  iconKey: "container",
  supportsCreate: true,
  supportsUpdate: true,
});

export const BucketResourceType = rt({
  id: "cos-bucket",
  name: "Object Storage Bucket",
  description: "A Cloud Object Storage bucket",
  fields: [
    f("name", "Name", { editable: false }),
    f("location", "Location", { editable: false }),
    f("storageClass", "Storage Class", { required: false, editable: false }),
    f("serviceInstanceId", "Service Instance", { required: false, editable: false }),
    f("objectCount", "Objects", { kind: "number", required: false, editable: false }),
    f("storageGb", "Stored (GB)", { kind: "number", required: false, editable: false }),
    createdField,
  ],
  outputs: [o("name", "Bucket Name"), o("endpoint", "Endpoint")],
  dependsOn: [
    {
      fieldKey: "serviceInstanceId",
      targetTypeId: "service-instance",
      targetKey: "guid",
      label: "in",
    },
  ],
  iconKey: "bucket",
  supportsCreate: true,
  supportsStorageBrowser: true,
});

export const DatabaseResourceType = rt({
  id: "database",
  name: "Cloud Database",
  description:
    "A Databases for PostgreSQL, MySQL, Redis, MongoDB, Elasticsearch, etcd or Messages for RabbitMQ deployment",
  fields: [
    f("name", "Name"),
    regionField,
    f("service", "Service", { editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("members", "Members", { kind: "number", required: false, editable: false }),
    f("memoryMb", "Memory per Member (MB)", {
      kind: "number",
      required: false,
      description: "Scaling restarts members one at a time",
    }),
    f("diskMb", "Disk per Member (MB)", {
      kind: "number",
      required: false,
      description: "Disk can only grow",
    }),
    f("cpu", "Dedicated vCPUs per Member", { kind: "number", required: false }),
    f("state", "State", { required: false, editable: false }),
    resourceGroupField,
    createdField,
  ],
  outputs: [o("host", "Host"), o("port", "Port"), o("id", "CRN")],
  dependsOn: [rgDep],
  iconKey: "database",
  supportsUpdate: true,
});

export const ServiceInstanceResourceType = rt({
  id: "service-instance",
  name: "Service Instance",
  description:
    "Any other IBM Cloud service instance (Cloud Object Storage, Key Protect, Event Streams, watsonx and so on)",
  fields: [
    f("name", "Name"),
    f("service", "Service", { editable: false }),
    f("plan", "Plan", { required: false, editable: false }),
    f("region", "Location", { required: false, editable: false }),
    f("guid", "GUID", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    resourceGroupField,
    createdField,
  ],
  outputs: [o("dashboardUrl", "Dashboard"), o("id", "CRN")],
  dependsOn: [rgDep],
  iconKey: "service",
  supportsUpdate: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  ResourceGroupResourceType,
  InstanceResourceType,
  VolumeResourceType,
  VpcResourceType,
  SubnetResourceType,
  SecurityGroupResourceType,
  FloatingIpResourceType,
  LoadBalancerResourceType,
  SshKeyResourceType,
  ClusterResourceType,
  WorkerPoolResourceType,
  CodeEngineProjectResourceType,
  CodeEngineAppResourceType,
  BucketResourceType,
  DatabaseResourceType,
  ServiceInstanceResourceType,
];
