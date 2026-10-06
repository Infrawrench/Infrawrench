import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { REGION_IDS } from "./regions.js";

/**
 * Resource types. External ids are Vultr's own UUIDs except where an
 * endpoint needs two parts: node pools (`{clusterId}/{poolId}`), database
 * users and logical databases (`{databaseId}/{name}`), DNS records
 * (`{domain}/{recordId}`), buckets (`{subscriptionId}/{bucket}`) and the
 * domain itself (the domain name is its id in the API).
 *
 * Billing facts the declarations lean on (Vultr docs "Billing FAQ", checked
 * 2026-10): instances, bare metal and block storage are billed hourly up to
 * a monthly cap whether running or stopped; only destroying them stops the
 * charges. Reserved IPs are billed whether or not they are attached.
 */

const region = () =>
  f("region", "Region", { kind: "enum", enumValues: REGION_IDS, editable: false });
const created = () => f("created", "Created", { required: false, editable: false });
const tags = () => f("tags", "Tags", { required: false, description: "Comma-separated tags" });

export const InstanceResourceType = rt({
  name: "Instance",
  id: "instance",
  description: "A Vultr cloud compute instance",
  fields: [
    f("label", "Label"),
    f("hostname", "Hostname", { required: false, editable: false }),
    f("status", "Status", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["active", "pending", "suspended", "resizing"],
    }),
    f("powerStatus", "Power", {
      kind: "enum",
      required: false,
      editable: false,
      enumValues: ["running", "stopped"],
    }),
    f("serverStatus", "Server Status", { required: false, editable: false }),
    f("plan", "Plan", {
      description:
        "Vultr plan id, e.g. vc2-1c-1gb. Changing it upgrades the instance; Vultr only allows moving to a plan with at least as much disk",
    }),
    region(),
    f("os", "Operating System", { required: false, editable: false }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("ramMb", "Memory (MB)", { kind: "number", required: false, editable: false }),
    f("diskGb", "Disk (GB)", { kind: "number", required: false, editable: false }),
    f("bandwidthGb", "Bandwidth Allowance (GB)", {
      kind: "number",
      required: false,
      editable: false,
    }),
    f("backupsEnabled", "Automatic Backups", {
      kind: "boolean",
      required: false,
      description: "Automatic backups are billed at 20% of the plan price",
    }),
    f("ddosProtection", "DDoS Protection", {
      kind: "boolean",
      required: false,
      description: "Billed per instance on top of the plan",
    }),
    f("ipv6Enabled", "IPv6", { kind: "boolean", required: false, editable: false }),
    f("firewallGroupId", "Firewall Group", {
      required: false,
      editable: false,
      description: "ID of the firewall group protecting this instance; empty when none",
    }),
    f("vpcOnly", "VPC Only", { kind: "boolean", required: false, editable: false }),
    tags(),
    created(),
  ],
  outputs: [
    o("ipv4", "Public IPv4"),
    o("ipv4Private", "Private IPv4"),
    o("ipv6", "IPv6"),
    o("instanceId", "Instance ID", { hidden: true }),
  ],
  dependsOn: [
    { fieldKey: "firewallGroupId", targetTypeId: "firewall-group", label: "protected by" },
  ],
  iconKey: "server",
  supportsCreate: true,
  // Edit = label, tags, plan (upgrade), backups and DDoS protection.
  supportsUpdate: true,
  supportsMetrics: true,
  sshEndpoint: {
    hostOutputKey: "ipv4",
    privateHostOutputKey: "ipv4Private",
    runningWhen: { fieldKey: "powerStatus", value: "running" },
    defaultUsername: "root",
  },
  agentVm: {
    sshKeyFieldKey: "sshPublicKey",
    defaultUsername: "root",
    defaultFields: { region: "ewr", plan: "vc2-2c-4gb", image: "os:2284" },
    linuxImageDefaults: { image: "os:2284" },
    hiddenFieldKeys: ["sshPublicKey", "userData"],
  },
  // Vultr keeps billing a halted instance; the declaration is still useful
  // for the power controls and schedules users run for other reasons.
  lifecycle: {
    startActionId: "start",
    stopActionId: "halt",
    statusFieldKey: "powerStatus",
    runningValues: ["running"],
    stoppedValues: ["stopped"],
  },
  orphanRule: {
    conditions: [{ fieldKey: "powerStatus", when: "equals", value: "stopped" }],
    reason:
      "Instance is stopped but Vultr still bills it at the full plan rate; only destroying it stops the charges",
  },
  backupPolicy: { protectedBy: [], automatedBackupFieldKey: "backupsEnabled" },
  carbon: { regionFieldKey: "region", vcpus: { from: "field", fieldKey: "vcpus" } },
  postureChecks: [
    {
      id: "vultr-instance-no-firewall",
      title: "No firewall group",
      severity: "high",
      category: "public-exposure",
      conditions: [
        { fieldKey: "firewallGroupId", when: "equals", value: "" },
        { fieldKey: "vpcOnly", when: "falsy" },
      ],
      reason:
        "No Vultr firewall group is attached, so every port the instance listens on is reachable from the internet.",
    },
    {
      id: "vultr-instance-backups-disabled",
      title: "Automatic backups disabled",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "backupsEnabled", when: "falsy" }],
      reason: "Automatic backups are off, so recovery depends on manual snapshots.",
    },
  ],
});

export const BareMetalResourceType = rt({
  name: "Bare Metal Server",
  id: "bare-metal",
  description: "A Vultr bare metal server",
  fields: [
    f("label", "Label"),
    f("status", "Status", { required: false, editable: false }),
    f("powerStatus", "Power", { required: false, editable: false }),
    f("plan", "Plan", { editable: false }),
    region(),
    f("os", "Operating System", { required: false, editable: false }),
    f("cpuCount", "CPU Cores", { kind: "number", required: false, editable: false }),
    f("ram", "Memory", { required: false, editable: false }),
    f("disk", "Disks", { required: false, editable: false }),
    tags(),
    created(),
  ],
  outputs: [o("ipv4", "Public IPv4"), o("ipv6", "IPv6")],
  iconKey: "server",
  supportsUpdate: true,
  supportsMetrics: true,
  sshEndpoint: {
    hostOutputKey: "ipv4",
    runningWhen: { fieldKey: "powerStatus", value: "running" },
    defaultUsername: "root",
  },
  lifecycle: {
    startActionId: "start",
    stopActionId: "halt",
    statusFieldKey: "powerStatus",
    runningValues: ["running"],
    stoppedValues: ["stopped"],
  },
  carbon: { regionFieldKey: "region", vcpus: { from: "field", fieldKey: "cpuCount" } },
});

export const BlockStorageResourceType = rt({
  name: "Block Storage",
  plural: "Block Storage Volumes",
  id: "block-storage",
  description: "A Vultr Block Storage volume",
  fields: [
    f("label", "Label", { required: false }),
    f("sizeGb", "Size (GB)", {
      kind: "number",
      description: "Volumes can grow but never shrink",
    }),
    region(),
    f("blockType", "Type", {
      kind: "enum",
      enumValues: ["high_perf", "storage_opt"],
      required: false,
      editable: false,
      description: "high_perf is NVMe; storage_opt is HDD",
    }),
    f("status", "Status", { required: false, editable: false }),
    f("attachedInstanceId", "Attached Instance", {
      required: false,
      editable: false,
      description: "ID of the instance this volume is attached to; empty when detached",
    }),
    f("attachedInstanceLabel", "Attached Instance Label", { required: false, editable: false }),
    f("mountId", "Mount ID", { required: false, editable: false }),
    f("monthlyCost", "Monthly Cost (USD)", { kind: "number", required: false, editable: false }),
    created(),
  ],
  outputs: [o("mountId", "Mount ID")],
  dependsOn: [{ fieldKey: "attachedInstanceId", targetTypeId: "instance", label: "attached to" }],
  iconKey: "volume",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "attachedInstanceId", when: "equals", value: "" }],
    reason: "Volume is not attached to any instance but is still billed per GB",
  },
  attachTargets: [
    { pluginId: "vultr", resourceTypeId: "instance", matchField: "region", verb: "Attach" },
  ],
});

export const SnapshotResourceType = rt({
  name: "Snapshot",
  id: "snapshot",
  description: "A point-in-time image of an instance, usable to deploy or restore",
  fields: [
    f("description", "Description", { required: false }),
    f("status", "Status", { required: false, editable: false }),
    f("sizeGb", "Size (GB)", { kind: "number", required: false, editable: false }),
    f("compressedSizeGb", "Billed Size (GB)", { kind: "number", required: false, editable: false }),
    f("osId", "OS ID", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("snapshotId", "Snapshot ID")],
  iconKey: "image",
  supportsCreate: true,
  supportsUpdate: true,
  // Vultr snapshots do not record their source instance, so they count but
  // cannot be attributed.
  backupRole: { role: "snapshot", createdKey: "createdAt", sizeKey: "compressedSizeGb" },
});

export const BackupResourceType = rt({
  name: "Backup",
  id: "backup",
  pinnable: false,
  description: "An automatic backup Vultr took of an instance",
  fields: [
    f("description", "Description", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("sizeGb", "Size (GB)", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("backupId", "Backup ID")],
  iconKey: "archive",
  supportsDelete: false,
  backupRole: { role: "snapshot", createdKey: "createdAt" },
});

export const KubernetesClusterResourceType = rt({
  name: "Kubernetes Cluster",
  id: "kubernetes-cluster",
  description: "A Vultr Kubernetes Engine (VKE) cluster",
  fields: [
    f("label", "Label"),
    region(),
    f("version", "Kubernetes Version", { editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("haControlPlanes", "HA Control Plane", { kind: "boolean", required: false, editable: false }),
    f("firewallGroupId", "Managed Firewall", { required: false, editable: false }),
    f("endpoint", "API Endpoint", { required: false, editable: false }),
    f("clusterSubnet", "Pod Subnet", { required: false, editable: false }),
    f("serviceSubnet", "Service Subnet", { required: false, editable: false }),
    f("poolCount", "Node Pools", { kind: "number", required: false, editable: false }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    f("nodePlan", "Node Plan", { required: false, editable: false }),
    created(),
  ],
  outputs: [
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Kubeconfig YAML for connecting to this cluster",
    }),
    o("apiEndpoint", "API Endpoint", { hidden: true }),
    o("clusterId", "Cluster ID", { hidden: true }),
  ],
  dependsOn: [
    { fieldKey: "firewallGroupId", targetTypeId: "firewall-group", label: "protected by" },
  ],
  iconKey: "kubernetes",
  supportsCreate: true,
  supportsUpdate: true,
  carbon: {
    role: "aggregate",
    regionFieldKey: "region",
    vcpus: {
      from: "size",
      catalogueTypeId: "instance",
      catalogueFieldKey: "plan",
      sizeFieldKey: "nodePlan",
    },
    countFieldKey: "nodeCount",
  },
  credentialFormats: [
    {
      id: "kubeconfig",
      label: "Kubeconfig",
      description: "The cluster's kubeconfig file for kubectl",
      mediaType: "text",
      filenameTemplate: "{name}-kubeconfig.yaml",
    },
  ],
  peerIntegrations: [
    {
      pluginId: "kubernetes",
      credentialMappings: [{ outputKey: "kubeconfig", credentialKey: "kubeconfig" }],
      tabLabel: "Kubernetes",
      exposeMetricsToParent: true,
    },
  ],
  secretExportTemplates: [
    {
      id: "vke-kubeconfig",
      displayName: "VKE Kubeconfig",
      description: "Kubeconfig for kubectl access to this VKE cluster",
      entries: [
        { envKey: "KUBECONFIG_DATA", outputKey: "kubeconfig" },
        { envKey: "KUBE_API_ENDPOINT", outputKey: "apiEndpoint" },
      ],
    },
  ],
});

export const NodePoolResourceType = rt({
  name: "Node Pool",
  id: "node-pool",
  pinnable: false,
  description: "A pool of identical worker nodes in a VKE cluster",
  fields: [
    f("label", "Label", { editable: false }),
    f("plan", "Node Plan", { editable: false }),
    f("nodeQuantity", "Nodes", { kind: "number" }),
    f("autoScaler", "Autoscaler", { kind: "boolean", required: false }),
    f("minNodes", "Autoscaler Minimum", { kind: "number", required: false }),
    f("maxNodes", "Autoscaler Maximum", { kind: "number", required: false }),
    f("tag", "Tag", { required: false }),
    f("status", "Status", { required: false, editable: false }),
    f("nodesActive", "Active Nodes", { kind: "number", required: false, editable: false }),
    f("clusterId", "Cluster", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "kubernetes-cluster",
  dependsOn: [{ fieldKey: "clusterId", targetTypeId: "kubernetes-cluster", label: "pool of" }],
  iconKey: "layers",
  supportsCreate: true,
  supportsUpdate: true,
  carbon: {
    role: "aggregate",
    regionFieldKey: "region",
    vcpus: {
      from: "size",
      catalogueTypeId: "instance",
      catalogueFieldKey: "plan",
      sizeFieldKey: "plan",
    },
    countFieldKey: "nodeQuantity",
  },
});

export const DatabaseResourceType = rt({
  name: "Managed Database",
  id: "database",
  description: "A Vultr Managed Database (MySQL, PostgreSQL, Valkey or Kafka)",
  fields: [
    f("label", "Label"),
    f("engine", "Engine", {
      kind: "enum",
      enumValues: ["mysql", "pg", "valkey", "kafka"],
      editable: false,
    }),
    f("version", "Version", { editable: false }),
    region(),
    f("status", "Status", { required: false, editable: false }),
    f("plan", "Plan", {
      description:
        "Changing the plan resizes the cluster; Vultr only allows moving to a larger disk",
    }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("ramMb", "Memory (MB)", { kind: "number", required: false, editable: false }),
    f("diskGb", "Disk (GB)", { kind: "number", required: false, editable: false }),
    f("replicas", "Replica Nodes", { kind: "number", required: false, editable: false }),
    f("trustedIps", "Trusted IPs", {
      required: false,
      description:
        "Comma-separated IPs or CIDR ranges allowed to connect; empty allows every address",
    }),
    f("maintenanceDow", "Maintenance Day", {
      kind: "enum",
      required: false,
      enumValues: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
    }),
    f("maintenanceTime", "Maintenance Time (UTC)", {
      required: false,
      description: "HH:00, e.g. 02:00",
    }),
    f("host", "Host", { required: false, editable: false }),
    f("publicHost", "Public Host", { required: false, editable: false }),
    f("port", "Port", { required: false, editable: false }),
    f("dbName", "Default Database", { required: false, editable: false }),
    f("latestBackup", "Latest Backup", { required: false, editable: false }),
    f("managedBackups", "Automatic Backups", { kind: "boolean", required: false, editable: false }),
    f("vpcId", "VPC", { required: false, editable: false }),
    f("tag", "Tag", { required: false }),
    created(),
  ],
  outputs: [
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "Full connection URI for the default user",
    }),
    o("host", "Host"),
    o("port", "Port"),
    o("username", "Username"),
    o("password", "Password", { sensitive: true }),
    o("database", "Database Name"),
    o("caCertificate", "CA Certificate", {
      description: "TLS CA certificate for verifying the server",
    }),
  ],
  dependsOn: [{ fieldKey: "vpcId", targetTypeId: "vpc", label: "in" }],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  carbon: { regionFieldKey: "region", vcpus: { from: "field", fieldKey: "vcpus" } },
  // Vultr backs up every MySQL, PostgreSQL and Valkey cluster daily; Kafka
  // has no backups at all, which the lister records as false.
  backupPolicy: { protectedBy: [], automatedBackupFieldKey: "managedBackups" },
  postureChecks: [
    {
      id: "vultr-database-open-to-all",
      title: "Database accepts connections from anywhere",
      severity: "high",
      category: "public-exposure",
      conditions: [
        { fieldKey: "trustedIps", when: "equals", value: "" },
        { fieldKey: "vpcId", when: "equals", value: "" },
      ],
      reason:
        "No trusted IPs are set, so Vultr accepts connection attempts to this database from the whole internet.",
    },
  ],
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "connectionString" },
        { outputKey: "caCertificate", credentialKey: "caCert" },
      ],
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "engine", equals: "pg" },
    },
    {
      pluginId: "mysql",
      credentialMappings: [
        { outputKey: "connectionString", credentialKey: "connectionString" },
        { outputKey: "caCertificate", credentialKey: "caCert" },
      ],
      tabLabel: "MySQL",
      showWhen: { fieldKey: "engine", equals: "mysql" },
    },
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Valkey",
      showWhen: { fieldKey: "engine", equals: "valkey" },
    },
    {
      pluginId: "kafka",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Kafka",
      showWhen: { fieldKey: "engine", equals: "kafka" },
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "Single DATABASE_URL containing the full connection string",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
    {
      id: "individual",
      displayName: "Individual Credentials",
      description: "Separate environment variables for host, port, user, password, and database",
      entries: [
        { envKey: "DB_HOST", outputKey: "host" },
        { envKey: "DB_PORT", outputKey: "port" },
        { envKey: "DB_USER", outputKey: "username" },
        { envKey: "DB_PASSWORD", outputKey: "password" },
        { envKey: "DB_NAME", outputKey: "database" },
      ],
    },
  ],
});

export const DatabaseUserResourceType = rt({
  name: "Database User",
  id: "database-user",
  pinnable: false,
  description: "A user on a Vultr Managed Database",
  fields: [
    f("username", "Username", { editable: false }),
    f("password", "Password", {
      kind: "password",
      required: false,
      description: "Leave empty to keep the current password",
    }),
    f("encryption", "Password Encryption", { required: false, editable: false }),
    f("permission", "Kafka Permission", { required: false, editable: false }),
    f("databaseId", "Database", { required: false, editable: false }),
  ],
  outputs: [o("password", "Password", { sensitive: true })],
  parentTypeId: "database",
  dependsOn: [{ fieldKey: "databaseId", targetTypeId: "database", label: "user of" }],
  iconKey: "user",
  supportsCreate: true,
  supportsUpdate: true,
});

export const LogicalDatabaseResourceType = rt({
  name: "Logical Database",
  id: "database-db",
  pinnable: false,
  description: "A database inside a Vultr MySQL or PostgreSQL cluster",
  fields: [
    f("name", "Name", { editable: false }),
    f("databaseId", "Cluster", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "database",
  dependsOn: [{ fieldKey: "databaseId", targetTypeId: "database", label: "in" }],
  iconKey: "database",
  supportsCreate: true,
});

export const LoadBalancerResourceType = rt({
  name: "Load Balancer",
  id: "load-balancer",
  description: "A Vultr managed load balancer",
  fields: [
    f("label", "Label", { required: false }),
    region(),
    f("status", "Status", { required: false, editable: false }),
    f("ipv4", "IPv4", { required: false, editable: false }),
    f("ipv6", "IPv6", { required: false, editable: false }),
    f("nodes", "Load Balancer Nodes", {
      kind: "number",
      required: false,
      description: "Odd number from 1 to 99; each node is billed",
    }),
    f("balancingAlgorithm", "Algorithm", {
      kind: "enum",
      required: false,
      enumValues: ["roundrobin", "leastconn"],
    }),
    f("sslRedirect", "Redirect HTTP to HTTPS", { kind: "boolean", required: false }),
    f("proxyProtocol", "Proxy Protocol", { kind: "boolean", required: false }),
    f("instanceIds", "Backend Instances", {
      required: false,
      editable: false,
      description: "Comma-separated instance IDs behind this load balancer",
    }),
    f("instanceCount", "Backends", { kind: "number", required: false, editable: false }),
    f("ruleCount", "Forwarding Rules", { kind: "number", required: false, editable: false }),
    f("hasSsl", "SSL Certificate", { kind: "boolean", required: false, editable: false }),
    f("healthCheck", "Health Check", { required: false, editable: false }),
    f("vpcId", "VPC", { required: false, editable: false }),
    created(),
  ],
  outputs: [o("ipv4", "IPv4"), o("ipv6", "IPv6")],
  dependsOn: [
    { fieldKey: "instanceIds", targetTypeId: "instance", label: "routes to" },
    { fieldKey: "vpcId", targetTypeId: "vpc", label: "in" },
  ],
  iconKey: "load-balancer",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "instanceCount", when: "equals", value: "0" }],
    reason: "Load balancer has no backend instances, so it serves nothing but is still billed",
  },
});

export const FirewallGroupResourceType = rt({
  name: "Firewall Group",
  id: "firewall-group",
  description: "A Vultr firewall group (a set of inbound allow rules)",
  fields: [
    f("description", "Description", { required: false }),
    f("ruleCount", "Rules", { kind: "number", required: false, editable: false }),
    f("maxRuleCount", "Rule Limit", { kind: "number", required: false, editable: false }),
    f("instanceCount", "Instances", { kind: "number", required: false, editable: false }),
    f("openToWorld", "Open to the Internet", {
      required: false,
      editable: false,
      description: "Ports allowed from 0.0.0.0/0 or ::/0 other than 80 and 443",
    }),
    created(),
  ],
  outputs: [o("firewallGroupId", "Firewall Group ID")],
  iconKey: "firewall",
  supportsCreate: true,
  supportsUpdate: true,
  attachTargets: [{ pluginId: "vultr", resourceTypeId: "instance", verb: "Protect" }],
  orphanRule: {
    conditions: [{ fieldKey: "instanceCount", when: "equals", value: "0" }],
    reason: "Firewall group protects no instance",
  },
  postureChecks: [
    {
      id: "vultr-firewall-sensitive-port-open",
      title: "Firewall allows the internet in on more than the web ports",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "openToWorld", when: "notEquals", value: "" }],
      reason:
        "At least one rule allows a port other than 80 or 443 from anywhere on the internet (for example SSH).",
    },
  ],
});

export const VpcResourceType = rt({
  name: "VPC",
  plural: "VPCs",
  id: "vpc",
  description: "A Vultr Virtual Private Cloud network",
  fields: [
    f("description", "Description", { required: false }),
    region(),
    f("subnet", "IPv4 Range", { required: false, editable: false }),
    f("attachmentCount", "Attached", { kind: "number", required: false, editable: false }),
    created(),
  ],
  outputs: [o("vpcId", "VPC ID")],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
  attachTargets: [
    { pluginId: "vultr", resourceTypeId: "instance", matchField: "region", verb: "Attach" },
  ],
});

export const ReservedIpResourceType = rt({
  name: "Reserved IP",
  id: "reserved-ip",
  description: "A reserved IPv4 address or IPv6 subnet",
  fields: [
    f("label", "Label", { required: false }),
    f("address", "Address", { required: false, editable: false }),
    f("ipType", "Type", { kind: "enum", enumValues: ["v4", "v6"], editable: false }),
    region(),
    f("instanceId", "Attached Instance", {
      required: false,
      editable: false,
      description: "ID of the instance using the address; empty when unattached",
    }),
  ],
  outputs: [o("ip", "IP Address")],
  dependsOn: [{ fieldKey: "instanceId", targetTypeId: "instance", label: "attached to" }],
  iconKey: "ip",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "instanceId", when: "equals", value: "" }],
    reason: "Reserved IP is not attached to anything but is billed whether or not it is in use",
  },
  attachTargets: [
    { pluginId: "vultr", resourceTypeId: "instance", matchField: "region", verb: "Attach" },
  ],
});

export const DomainResourceType = rt({
  name: "DNS Domain",
  id: "domain",
  description: "A domain hosted on Vultr DNS",
  fields: [
    f("domain", "Domain", { editable: false }),
    f("dnsSec", "DNSSEC", { kind: "enum", required: false, enumValues: ["enabled", "disabled"] }),
    f("soaPrimary", "SOA Primary Nameserver", { required: false }),
    f("soaEmail", "SOA Email", { required: false }),
    f("recordCount", "Records", { kind: "number", required: false, editable: false }),
    created(),
  ],
  outputs: [o("nameservers", "Nameservers")],
  iconKey: "dns",
  supportsCreate: true,
  supportsUpdate: true,
  dnsRole: { role: "zone", domainKey: "domain", recordCountKey: "recordCount" },
});

export const DnsRecordResourceType = rt({
  name: "DNS Record",
  id: "dns-record",
  pinnable: false,
  description: "A DNS record in a Vultr DNS domain",
  fields: [
    f("type", "Type", {
      kind: "enum",
      enumValues: ["A", "AAAA", "CNAME", "NS", "MX", "SRV", "TXT", "CAA", "SSHFP"],
      editable: false,
    }),
    f("name", "Name", {
      required: false,
      description: "Relative to the domain; empty for the apex",
    }),
    f("data", "Data"),
    f("ttl", "TTL", { kind: "number", required: false }),
    f("priority", "Priority", { kind: "number", required: false }),
    f("domainName", "Domain", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "domain",
  dependsOn: [
    { fieldKey: "domainName", targetTypeId: "domain", targetKey: "domain", label: "in domain" },
  ],
  iconKey: "dns-record",
  supportsCreate: true,
  supportsUpdate: true,
  dnsRole: {
    role: "record",
    nameKey: "name",
    typeKey: "type",
    contentKey: "data",
    ttlKey: "ttl",
    priorityKey: "priority",
    zoneKey: "domainName",
  },
});

export const ObjectStorageResourceType = rt({
  name: "Object Storage",
  plural: "Object Storage Subscriptions",
  id: "object-storage",
  description: "A Vultr Object Storage subscription (an S3 endpoint with its own keys)",
  fields: [
    f("label", "Label"),
    region(),
    f("status", "Status", { required: false, editable: false }),
    f("tier", "Tier", { required: false, editable: false }),
    f("s3Hostname", "S3 Hostname", { required: false, editable: false }),
    f("clusterId", "Cluster", { kind: "number", required: false, editable: false }),
    created(),
  ],
  outputs: [
    o("s3Endpoint", "S3 Endpoint"),
    o("accessKey", "Access Key"),
    o("secretKey", "Secret Key", { sensitive: true }),
  ],
  iconKey: "storage",
  supportsCreate: true,
  supportsUpdate: true,
  secretExportTemplates: [
    {
      id: "s3-credentials",
      displayName: "S3 credentials",
      description: "Endpoint and keys for any S3-compatible client",
      entries: [
        { envKey: "AWS_ENDPOINT_URL", outputKey: "s3Endpoint" },
        { envKey: "AWS_ACCESS_KEY_ID", outputKey: "accessKey" },
        { envKey: "AWS_SECRET_ACCESS_KEY", outputKey: "secretKey" },
      ],
    },
  ],
  dnsServiceHosts: [
    {
      id: "vultr-object-storage",
      label: "Vultr Object Storage bucket",
      hostPattern: "([a-z0-9][a-z0-9.-]*?)\\.[a-z0-9-]+\\.vultrobjects\\.com",
      labelIs: "name",
      reason:
        "The record points at a Vultr Object Storage bucket name no synced bucket owns; anyone can create it and serve content from your domain.",
    },
  ],
});

export const BucketResourceType = rt({
  name: "Bucket",
  id: "bucket",
  description: "A bucket inside a Vultr Object Storage subscription",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Region", { required: false, editable: false }),
    f("subscriptionId", "Subscription", { required: false, editable: false }),
    f("s3Hostname", "S3 Hostname", { required: false, editable: false }),
    created(),
  ],
  outputs: [o("url", "Bucket URL")],
  parentTypeId: "object-storage",
  showInSidebar: true,
  dependsOn: [{ fieldKey: "subscriptionId", targetTypeId: "object-storage", label: "in" }],
  iconKey: "storage",
  supportsCreate: true,
  supportsStorageBrowser: true,
});

export const SshKeyResourceType = rt({
  name: "SSH Key",
  id: "ssh-key",
  pinnable: false,
  description: "A public SSH key stored in the Vultr account",
  fields: [
    f("name", "Name"),
    f("publicKey", "Public Key", { required: false, editable: false }),
    created(),
  ],
  outputs: [o("sshKeyId", "SSH Key ID")],
  iconKey: "key",
  supportsCreate: true,
  supportsUpdate: true,
  expiryFields: [{ fieldKey: "created", from: "created", kind: "ssh-key", label: "SSH key age" }],
});

export const StartupScriptResourceType = rt({
  name: "Startup Script",
  id: "startup-script",
  pinnable: false,
  description: "A boot or PXE script run when an instance is deployed",
  fields: [
    f("name", "Name"),
    f("type", "Type", { kind: "enum", enumValues: ["boot", "pxe"], editable: false }),
    f("script", "Script", { required: false }),
    f("updated", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("scriptId", "Script ID")],
  iconKey: "code",
  supportsCreate: true,
  supportsUpdate: true,
});

export const AccountResourceType = rt({
  name: "Billing Account",
  id: "account",
  description: "The Vultr account's balance, month-to-date charges and bandwidth pool",
  fields: [
    f("name", "Name", { required: false }),
    f("email", "Email", { required: false }),
    f("balance", "Balance (USD)", {
      kind: "number",
      required: false,
      description: "Negative means the account holds a credit",
    }),
    f("pendingCharges", "Month-to-date Charges (USD)", { kind: "number", required: false }),
    f("lastPaymentDate", "Last Payment", { required: false }),
    f("lastPaymentAmount", "Last Payment Amount (USD)", { kind: "number", required: false }),
    f("bandwidthGbOut", "Bandwidth Out This Month (GB)", { kind: "number", required: false }),
    f("bandwidthCreditsGb", "Bandwidth Pool (GB)", { kind: "number", required: false }),
    f("bandwidthProjectedOverage", "Projected Overage (USD)", { kind: "number", required: false }),
  ],
  outputs: [],
  iconKey: "account",
  supportsDelete: false,
});

export const InvoiceResourceType = rt({
  name: "Invoice",
  id: "invoice",
  pinnable: false,
  description: "A monthly Vultr invoice and its line items",
  fields: [
    f("description", "Invoice"),
    f("date", "Date"),
    f("amount", "Amount (USD)", { kind: "number", required: false }),
    f("balance", "Balance (USD)", { kind: "number", required: false }),
  ],
  outputs: [],
  parentTypeId: "account",
  iconKey: "file",
  supportsDelete: false,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  InstanceResourceType,
  BareMetalResourceType,
  BlockStorageResourceType,
  SnapshotResourceType,
  BackupResourceType,
  KubernetesClusterResourceType,
  NodePoolResourceType,
  DatabaseResourceType,
  DatabaseUserResourceType,
  LogicalDatabaseResourceType,
  LoadBalancerResourceType,
  FirewallGroupResourceType,
  VpcResourceType,
  ReservedIpResourceType,
  DomainResourceType,
  DnsRecordResourceType,
  ObjectStorageResourceType,
  BucketResourceType,
  SshKeyResourceType,
  StartupScriptResourceType,
  AccountResourceType,
  InvoiceResourceType,
];
