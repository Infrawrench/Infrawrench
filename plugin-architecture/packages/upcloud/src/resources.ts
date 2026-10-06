import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * Resource types. External ids are UpCloud UUIDs (the API is account-wide,
 * so no zone prefix is needed), except node groups `{cluster}/{name}`,
 * database users and logical databases `{database}/{name}`, Object Storage
 * buckets and users `{service}/{name}`, and floating IPs, whose id is the
 * address.
 *
 * Billing facts (upcloud.com/pricing, checked 2026-10): servers are billed
 * hourly while they exist, stopped servers keep billing their storage and
 * IPs, storage and backups bill per GB, floating IPs bill per hour.
 */

const zone = () => f("region", "Zone", { editable: false });
const labels = () =>
  f("labels", "Labels", { required: false, description: "Comma-separated key=value labels" });

export const ServerResourceType = rt({
  name: "Server",
  id: "server",
  description: "An UpCloud cloud server",
  fields: [
    f("title", "Title"),
    f("hostname", "Hostname"),
    f("state", "State", { required: false, editable: false }),
    f("plan", "Plan", {
      description: "Simple plan, e.g. 2xCPU-4GB. Changing it needs the server to be stopped",
    }),
    zone(),
    f("cores", "vCPUs", { kind: "number", required: false, editable: false }),
    f("memoryMb", "Memory (MB)", { kind: "number", required: false, editable: false }),
    f("firewall", "Firewall", {
      kind: "boolean",
      required: false,
      description: "Whether the server's own firewall rules are enforced",
    }),
    f("simpleBackup", "Simple Backup", {
      kind: "enum",
      required: false,
      enumValues: ["no", "dailies", "weeklies", "monthlies"],
      description: "Daily backup plan taken at 04:00 UTC (billed on top of the plan)",
    }),
    f("backupsOn", "Automatic Backups", { kind: "boolean", required: false, editable: false }),
    f("storages", "Storage Devices", { required: false, editable: false }),
    f("serverGroup", "Server Group", { required: false, editable: false }),
    f("metadata", "Metadata Service", { kind: "boolean", required: false, editable: false }),
    labels(),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("ipv4", "Public IPv4"),
    o("ipv4Private", "Utility IPv4"),
    o("ipv6", "IPv6"),
    o("serverId", "Server ID", { hidden: true }),
  ],
  iconKey: "server",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  sshEndpoint: {
    hostOutputKey: "ipv4",
    privateHostOutputKey: "ipv4Private",
    runningWhen: { fieldKey: "state", value: "started" },
    defaultUsername: "root",
  },
  agentVm: {
    sshKeyFieldKey: "sshPublicKey",
    defaultUsername: "root",
    defaultFields: { zone: "fi-hel1", plan: "2xCPU-4GB" },
    hiddenFieldKeys: ["sshPublicKey", "userData"],
  },
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "state",
    runningValues: ["started"],
    stoppedValues: ["stopped"],
  },
  orphanRule: {
    conditions: [{ fieldKey: "state", when: "equals", value: "stopped" }],
    reason: "Server is stopped; UpCloud still bills its storage and IP addresses",
  },
  backupPolicy: { protectedBy: ["backup"], automatedBackupFieldKey: "backupsOn" },
  carbon: { regionFieldKey: "region", vcpus: { from: "field", fieldKey: "cores" } },
  postureChecks: [
    {
      id: "upcloud-server-firewall-off",
      title: "Server firewall is off",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "firewall", when: "falsy" }],
      reason:
        "The server's firewall is off, so every port it listens on is reachable from the internet.",
    },
  ],
});

export const StorageResourceType = rt({
  name: "Storage",
  plural: "Storages",
  id: "storage",
  description: "An UpCloud block storage device",
  fields: [
    f("title", "Title"),
    f("sizeGb", "Size (GB)", { kind: "number", description: "Storage can grow but never shrink" }),
    f("tier", "Tier", {
      kind: "enum",
      enumValues: ["maxiops", "standard", "hdd"],
      editable: false,
    }),
    zone(),
    f("state", "State", { required: false, editable: false }),
    f("serverIds", "Attached Servers", {
      required: false,
      editable: false,
      description: "IDs of the servers this storage is attached to; empty when detached",
    }),
    f("encrypted", "Encrypted", { kind: "boolean", required: false, editable: false }),
    f("backupRule", "Backup Rule", {
      required: false,
      description:
        "Automatic backup rule as interval,HHMM,retention-days, e.g. daily,0430,7; empty for none",
    }),
    f("backupCount", "Backups", { kind: "number", required: false, editable: false }),
    labels(),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("storageId", "Storage ID", { hidden: true })],
  dependsOn: [{ fieldKey: "serverIds", targetTypeId: "server", label: "attached to" }],
  iconKey: "volume",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "serverIds", when: "equals", value: "" }],
    reason: "Storage is not attached to any server but is still billed per GB",
  },
  attachTargets: [
    { pluginId: "upcloud", resourceTypeId: "server", matchField: "region", verb: "Attach" },
  ],
  backupPolicy: {
    protectedBy: ["backup"],
    automatedBackupFieldKey: "backupRule",
    automatedBackupWhen: "present",
  },
  postureChecks: [
    {
      id: "upcloud-storage-unencrypted",
      title: "Storage not encrypted at rest",
      severity: "low",
      category: "encryption",
      conditions: [{ fieldKey: "encrypted", when: "falsy" }],
      reason: "This storage device is not encrypted at rest.",
    },
  ],
});

export const BackupResourceType = rt({
  name: "Backup",
  id: "backup",
  description: "A backup of an UpCloud storage device",
  fields: [
    f("title", "Title", { editable: false }),
    f("origin", "Source Storage", { required: false, editable: false }),
    f("sizeGb", "Size (GB)", { kind: "number", required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    zone(),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "origin", targetTypeId: "storage", label: "backup of" }],
  iconKey: "archive",
  supportsCreate: true,
  backupRole: { role: "snapshot", sourceKey: "origin", createdKey: "createdAt", sizeKey: "sizeGb" },
});

export const TemplateResourceType = rt({
  name: "Template",
  id: "template",
  description: "A private template made from one of your storages",
  fields: [
    f("title", "Title"),
    f("sizeGb", "Size (GB)", { kind: "number", required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    zone(),
    f("templateType", "Template Type", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("templateId", "Template ID", { hidden: true })],
  iconKey: "image",
  supportsCreate: true,
  supportsUpdate: true,
});

export const NetworkResourceType = rt({
  name: "Network",
  id: "network",
  description: "An UpCloud private network (SDN)",
  fields: [
    f("name", "Name"),
    zone(),
    f("cidr", "IPv4 Range", { required: false, editable: false }),
    f("dhcp", "DHCP", { kind: "boolean", required: false, editable: false }),
    f("router", "Router", { required: false, editable: false }),
    f("serverCount", "Servers", { kind: "number", required: false, editable: false }),
    labels(),
  ],
  outputs: [o("networkId", "Network ID", { hidden: true })],
  dependsOn: [{ fieldKey: "router", targetTypeId: "router", label: "routed by" }],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

export const RouterResourceType = rt({
  name: "Router",
  id: "router",
  description: "An UpCloud router connecting private networks",
  fields: [
    f("name", "Name"),
    f("networkCount", "Networks", { kind: "number", required: false, editable: false }),
    f("staticRoutes", "Static Routes", { required: false, editable: false }),
    labels(),
  ],
  outputs: [o("routerId", "Router ID", { hidden: true })],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

export const FloatingIpResourceType = rt({
  name: "Floating IP",
  id: "floating-ip",
  description: "A floating IP address that can move between servers",
  fields: [
    f("address", "Address", { editable: false }),
    f("family", "Family", { required: false, editable: false }),
    zone(),
    f("serverId", "Assigned Server", {
      required: false,
      editable: false,
      description: "ID of the server holding the address; empty when unassigned",
    }),
    f("ptrRecord", "Reverse DNS", { required: false }),
  ],
  outputs: [o("ip", "IP Address")],
  dependsOn: [{ fieldKey: "serverId", targetTypeId: "server", label: "assigned to" }],
  iconKey: "ip",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "serverId", when: "equals", value: "" }],
    reason: "Floating IP is not assigned to a server but is still billed",
  },
  attachTargets: [
    { pluginId: "upcloud", resourceTypeId: "server", matchField: "region", verb: "Assign" },
  ],
});

export const KubernetesClusterResourceType = rt({
  name: "Kubernetes Cluster",
  id: "kubernetes-cluster",
  description: "An UpCloud Managed Kubernetes cluster",
  fields: [
    f("name", "Name", { editable: false }),
    zone(),
    f("version", "Kubernetes Version", { editable: false }),
    f("plan", "Control Plane Plan", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("network", "Network", { required: false, editable: false }),
    f("networkCidr", "Network Range", { required: false, editable: false }),
    f("privateNodeGroups", "Private Node Groups", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("controlPlaneIpFilter", "API Allowed IPs", {
      required: false,
      description:
        "Comma-separated CIDRs allowed to reach the Kubernetes API; 0.0.0.0/0 for anywhere",
    }),
    f("nodeGroupCount", "Node Groups", { kind: "number", required: false, editable: false }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    f("nodePlan", "Node Plan", { required: false, editable: false }),
    labels(),
  ],
  outputs: [
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Kubeconfig YAML",
    }),
    o("apiEndpoint", "API Endpoint", { hidden: true }),
    o("clusterId", "Cluster ID", { hidden: true }),
  ],
  dependsOn: [{ fieldKey: "network", targetTypeId: "network", label: "in" }],
  iconKey: "kubernetes",
  supportsCreate: true,
  supportsUpdate: true,
  carbon: {
    role: "aggregate",
    regionFieldKey: "region",
    vcpus: {
      from: "size",
      catalogueTypeId: "server",
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
  postureChecks: [
    {
      id: "upcloud-k8s-api-open",
      title: "Kubernetes API open to the internet",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "controlPlaneIpFilter", when: "equals", value: "0.0.0.0/0" }],
      reason: "The control plane accepts connections from any address.",
    },
  ],
});

export const NodeGroupResourceType = rt({
  name: "Node Group",
  id: "node-group",
  pinnable: false,
  description: "A group of identical worker nodes in an UpCloud Kubernetes cluster",
  fields: [
    f("name", "Name", { editable: false }),
    f("plan", "Node Plan", { editable: false }),
    f("count", "Nodes", { kind: "number" }),
    f("state", "State", { required: false, editable: false }),
    f("antiAffinity", "Anti-affinity", { kind: "boolean", required: false, editable: false }),
    f("clusterId", "Cluster", { required: false, editable: false }),
    f("region", "Zone", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "kubernetes-cluster",
  dependsOn: [{ fieldKey: "clusterId", targetTypeId: "kubernetes-cluster", label: "group of" }],
  iconKey: "layers",
  supportsCreate: true,
  supportsUpdate: true,
  carbon: {
    role: "aggregate",
    regionFieldKey: "region",
    vcpus: {
      from: "size",
      catalogueTypeId: "server",
      catalogueFieldKey: "plan",
      sizeFieldKey: "plan",
    },
    countFieldKey: "count",
  },
});

export const DatabaseResourceType = rt({
  name: "Managed Database",
  id: "database",
  description: "An UpCloud Managed Database (PostgreSQL, MySQL, Valkey or OpenSearch)",
  fields: [
    f("title", "Title"),
    f("type", "Engine", {
      kind: "enum",
      enumValues: ["pg", "mysql", "valkey", "opensearch"],
      editable: false,
    }),
    f("version", "Version", { required: false, editable: false }),
    zone(),
    f("state", "State", { required: false, editable: false }),
    f("powered", "Powered On", { kind: "boolean", required: false }),
    f("plan", "Plan", { description: "Changing the plan resizes the service" }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    f("host", "Host", { required: false, editable: false }),
    f("port", "Port", { required: false, editable: false }),
    f("publicAccess", "Public Access", { kind: "boolean", required: false }),
    f("ipFilter", "Allowed IPs", {
      required: false,
      description: "Comma-separated CIDRs allowed to connect; 0.0.0.0/0 allows everyone",
    }),
    f("maintenanceDow", "Maintenance Day", {
      kind: "enum",
      required: false,
      enumValues: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
    }),
    f("maintenanceTime", "Maintenance Time (UTC)", { required: false, description: "hh:mm:ss" }),
    f("terminationProtection", "Termination Protection", { kind: "boolean", required: false }),
    f("backupCount", "Backups", { kind: "number", required: false, editable: false }),
    labels(),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "Service URI for the admin user",
    }),
    o("host", "Host"),
    o("port", "Port"),
    o("username", "Username"),
    o("password", "Password", { sensitive: true }),
    o("database", "Database Name"),
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  lifecycle: {
    startActionId: "power-on",
    stopActionId: "power-off",
    statusFieldKey: "powered",
    runningValues: ["true"],
    stoppedValues: ["false"],
  },
  backupPolicy: {
    protectedBy: [],
    automatedBackupFieldKey: "backupCount",
    automatedBackupWhen: "truthy",
  },
  postureChecks: [
    {
      id: "upcloud-database-open-to-all",
      title: "Database accepts connections from anywhere",
      severity: "high",
      category: "public-exposure",
      conditions: [
        { fieldKey: "publicAccess", when: "truthy" },
        { fieldKey: "ipFilter", when: "equals", value: "0.0.0.0/0" },
      ],
      reason: "Public access is on and the IP filter allows every address.",
    },
    {
      id: "upcloud-database-no-termination-protection",
      title: "Termination protection off",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "terminationProtection", when: "falsy" }],
      reason: "The database can be deleted without first turning termination protection off.",
    },
  ],
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "type", equals: "pg" },
    },
    {
      pluginId: "mysql",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MySQL",
      showWhen: { fieldKey: "type", equals: "mysql" },
    },
    {
      pluginId: "redis",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "Valkey",
      showWhen: { fieldKey: "type", equals: "valkey" },
    },
  ],
  secretExportTemplates: [
    {
      id: "connection-url",
      displayName: "Connection URL",
      description: "Single DATABASE_URL containing the full connection string",
      entries: [{ envKey: "DATABASE_URL", outputKey: "connectionString" }],
    },
  ],
});

export const DatabaseUserResourceType = rt({
  name: "Database User",
  id: "database-user",
  pinnable: false,
  description: "A user of an UpCloud Managed Database",
  fields: [
    f("username", "Username", { editable: false }),
    f("password", "Password", {
      kind: "password",
      required: false,
      description: "Leave empty to keep it",
    }),
    f("type", "Type", { required: false, editable: false }),
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
  description: "A database inside an UpCloud PostgreSQL or MySQL service",
  fields: [
    f("name", "Name", { editable: false }),
    f("databaseId", "Service", { required: false, editable: false }),
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
  description: "An UpCloud Managed Load Balancer",
  fields: [
    f("name", "Name"),
    zone(),
    f("plan", "Plan", {
      kind: "enum",
      enumValues: ["development", "production-small", "production-medium", "production-large"],
    }),
    f("configuredStatus", "Configured Status", {
      kind: "enum",
      required: false,
      enumValues: ["started", "stopped"],
    }),
    f("operationalState", "State", { required: false, editable: false }),
    f("dnsName", "DNS Name", { required: false, editable: false }),
    f("frontendCount", "Frontends", { kind: "number", required: false, editable: false }),
    f("backendCount", "Backends", { kind: "number", required: false, editable: false }),
    f("memberCount", "Backend Members", { kind: "number", required: false, editable: false }),
    f("network", "Private Network", { required: false, editable: false }),
    f("maintenanceDow", "Maintenance Day", { required: false, editable: false }),
    labels(),
  ],
  outputs: [o("hostname", "DNS Name")],
  dependsOn: [{ fieldKey: "network", targetTypeId: "network", label: "routes into" }],
  iconKey: "load-balancer",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "memberCount", when: "equals", value: "0" }],
    reason: "Load balancer has no backend members, so it serves nothing but is still billed",
  },
  dnsServiceHosts: [
    {
      id: "upcloud-load-balancer",
      label: "UpCloud load balancer hostname",
      hostPattern: "(lb-[0-9a-f]+-\\d+)\\.upcloudlb\\.com",
      labelIs: "opaque",
      hostKeys: ["dnsName"],
      reason:
        "The record points at an UpCloud load balancer hostname no synced load balancer owns.",
    },
  ],
});

export const ObjectStorageResourceType = rt({
  name: "Object Storage",
  plural: "Object Storage Services",
  id: "object-storage",
  description: "An UpCloud Managed Object Storage service (S3-compatible)",
  fields: [
    f("name", "Name"),
    f("region", "Region", { editable: false }),
    f("configuredStatus", "Configured Status", {
      kind: "enum",
      required: false,
      enumValues: ["started", "stopped"],
    }),
    f("operationalState", "State", { required: false, editable: false }),
    f("endpoint", "Public Endpoint", { required: false, editable: false }),
    f("totalObjects", "Objects", { kind: "number", required: false, editable: false }),
    f("totalSizeGb", "Stored (GB)", { kind: "number", required: false, editable: false }),
    labels(),
  ],
  outputs: [o("endpoint", "S3 Endpoint")],
  iconKey: "storage",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
});

export const BucketResourceType = rt({
  name: "Bucket",
  id: "bucket",
  pinnable: false,
  description: "A bucket in an UpCloud Managed Object Storage service",
  fields: [
    f("name", "Name", { editable: false }),
    f("serviceId", "Service", { required: false, editable: false }),
    f("totalObjects", "Objects", { kind: "number", required: false, editable: false }),
    f("totalSizeBytes", "Size (bytes)", { kind: "number", required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "object-storage",
  showInSidebar: true,
  dependsOn: [{ fieldKey: "serviceId", targetTypeId: "object-storage", label: "in" }],
  iconKey: "storage",
  supportsCreate: true,
});

export const ObjectStorageUserResourceType = rt({
  name: "Object Storage User",
  id: "object-storage-user",
  pinnable: false,
  description: "A user with access keys for an UpCloud Managed Object Storage service",
  fields: [
    f("username", "Username", { editable: false }),
    f("policies", "Policies", { required: false, editable: false }),
    f("accessKeyCount", "Access Keys", { kind: "number", required: false, editable: false }),
    f("serviceId", "Service", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "object-storage",
  dependsOn: [{ fieldKey: "serviceId", targetTypeId: "object-storage", label: "user of" }],
  iconKey: "key",
  supportsCreate: true,
  credentialFormats: [
    {
      id: "access-key",
      label: "Access key",
      description: "A new S3 access key ID and secret for this user",
      mediaType: "ini",
      filenameTemplate: "{name}-credentials.ini",
    },
  ],
});

export const AccountResourceType = rt({
  name: "Account",
  id: "account",
  description: "The UpCloud account's credit balance and resource limits",
  fields: [
    f("username", "Username", { required: false }),
    f("credits", "Credits", { kind: "number", required: false }),
    f("currency", "Currency", { required: false }),
    f("limits", "Resource Limits", { required: false }),
  ],
  outputs: [],
  iconKey: "account",
  supportsDelete: false,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ServerResourceType,
  StorageResourceType,
  BackupResourceType,
  TemplateResourceType,
  NetworkResourceType,
  RouterResourceType,
  FloatingIpResourceType,
  KubernetesClusterResourceType,
  NodeGroupResourceType,
  DatabaseResourceType,
  DatabaseUserResourceType,
  LogicalDatabaseResourceType,
  LoadBalancerResourceType,
  ObjectStorageResourceType,
  BucketResourceType,
  ObjectStorageUserResourceType,
  AccountResourceType,
];
