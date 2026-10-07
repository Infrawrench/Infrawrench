import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * Resource types. Zonal resources use `{zone}/{uuid}` external ids (the
 * zone picks the API endpoint); node pools and NLB services add their
 * parent (`{zone}/{cluster}/{pool}`), DBaaS services are `{zone}/{name}`
 * (services are addressed by name), DNS records `{domain}/{record}`,
 * buckets `{zone}/{name}`, and SSH keys their name. Security groups,
 * anti-affinity groups and DNS domains are account-wide UUIDs.
 *
 * Billing facts (exoscale.com/pricing, checked 2026-10): instances are
 * billed per second while running; a stopped instance bills only its disk.
 * Elastic IPs, volumes, snapshots and NLBs bill while they exist.
 */

const zone = () => f("region", "Zone", { editable: false });
const labels = () =>
  f("labels", "Labels", { required: false, description: "Comma-separated key=value labels" });

export const InstanceResourceType = rt({
  name: "Compute Instance",
  id: "instance",
  description: "An Exoscale compute instance",
  fields: [
    f("name", "Name"),
    zone(),
    f("state", "State", { required: false, editable: false }),
    f("instanceType", "Type", {
      description:
        "family.size, e.g. standard.medium. Changing it needs the instance to be stopped",
    }),
    f("cpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("memoryMb", "Memory (MB)", { kind: "number", required: false, editable: false }),
    f("diskGb", "Disk (GB)", { kind: "number", description: "The disk can only grow" }),
    f("template", "Template", { required: false, editable: false }),
    f("defaultUser", "Default User", { required: false, editable: false }),
    f("securityGroupIds", "Security Groups", { required: false, editable: false }),
    f("privateNetworkIds", "Private Networks", { required: false, editable: false }),
    f("elasticIpIds", "Elastic IPs", { required: false, editable: false }),
    f("managedBy", "Managed By", {
      required: false,
      editable: false,
      description: "SKS node pool or instance pool that owns it",
    }),
    f("snapshotCount", "Snapshots", { kind: "number", required: false, editable: false }),
    f("diskEncrypted", "Disk Encrypted", { kind: "boolean", required: false, editable: false }),
    labels(),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("ipv4", "Public IPv4"),
    o("ipv6", "IPv6"),
    o("instanceId", "Instance ID", { hidden: true }),
    o("instanceRef", "Instance Reference", { hidden: true }),
  ],
  dependsOn: [
    { fieldKey: "securityGroupIds", targetTypeId: "security-group", label: "protected by" },
  ],
  iconKey: "server",
  supportsCreate: true,
  supportsUpdate: true,
  sshEndpoint: {
    hostOutputKey: "ipv4",
    runningWhen: { fieldKey: "state", value: "running" },
    defaultUsername: "ubuntu",
    usernameFieldKey: "defaultUser",
  },
  agentVm: {
    sshKeyFieldKey: "sshPublicKey",
    defaultUsername: "ubuntu",
    defaultFields: { zone: "ch-gva-2", instanceType: "standard.medium", diskGb: "50" },
    hiddenFieldKeys: ["sshPublicKey", "userData"],
  },
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "state",
    runningValues: ["running"],
    stoppedValues: ["stopped"],
  },
  orphanRule: {
    conditions: [
      { fieldKey: "state", when: "equals", value: "stopped" },
      { fieldKey: "managedBy", when: "equals", value: "" },
    ],
    reason: "Instance is stopped; Exoscale still bills its disk",
  },
  backupPolicy: { protectedBy: ["snapshot"] },
  carbon: { regionFieldKey: "region", vcpus: { from: "field", fieldKey: "cpus" } },
  postureChecks: [
    {
      id: "exoscale-instance-no-security-group",
      title: "No security group",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "securityGroupIds", when: "equals", value: "" }],
      reason:
        "The instance belongs to no security group, so Exoscale applies the default group's rules.",
    },
    {
      id: "exoscale-instance-disk-unencrypted",
      title: "Disk not encrypted",
      severity: "low",
      category: "encryption",
      conditions: [{ fieldKey: "diskEncrypted", when: "falsy" }],
      reason: "The instance's root disk is not encrypted at rest.",
    },
  ],
});

export const BlockStorageResourceType = rt({
  name: "Block Storage Volume",
  id: "block-storage",
  description: "An Exoscale block storage volume",
  fields: [
    f("name", "Name"),
    zone(),
    f("sizeGb", "Size (GB)", { kind: "number", description: "Volumes can grow but never shrink" }),
    f("state", "State", { required: false, editable: false }),
    f("instanceId", "Attached Instance", { required: false, editable: false }),
    f("encrypted", "Encrypted", { kind: "boolean", required: false, editable: false }),
    f("snapshotCount", "Snapshots", { kind: "number", required: false, editable: false }),
    labels(),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("volumeId", "Volume ID", { hidden: true }),
    o("volumeRef", "Volume Reference", { hidden: true }),
  ],
  dependsOn: [
    {
      fieldKey: "instanceId",
      targetTypeId: "instance",
      targetKey: "instanceId",
      label: "attached to",
    },
  ],
  iconKey: "volume",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "instanceId", when: "equals", value: "" }],
    reason: "Volume is not attached to any instance but is still billed per GB",
  },
  attachTargets: [
    { pluginId: "exoscale", resourceTypeId: "instance", matchField: "region", verb: "Attach" },
  ],
  backupPolicy: { protectedBy: ["block-storage-snapshot"] },
});

export const BlockStorageSnapshotResourceType = rt({
  name: "Volume Snapshot",
  id: "block-storage-snapshot",
  description: "A snapshot of an Exoscale block storage volume",
  fields: [
    f("name", "Name"),
    zone(),
    f("state", "State", { required: false, editable: false }),
    f("sizeGb", "Size (GB)", { kind: "number", required: false, editable: false }),
    f("sourceRef", "Volume", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("snapshotId", "Snapshot ID", { hidden: true })],
  iconKey: "image",
  supportsCreate: true,
  supportsUpdate: true,
  backupRole: {
    role: "snapshot",
    sourceKey: "sourceRef",
    createdKey: "createdAt",
    sizeKey: "sizeGb",
  },
});

export const SnapshotResourceType = rt({
  name: "Instance Snapshot",
  id: "snapshot",
  description: "A snapshot of an Exoscale instance's disk",
  fields: [
    f("name", "Name", { editable: false }),
    zone(),
    f("state", "State", { required: false, editable: false }),
    f("sizeGb", "Size (GB)", { kind: "number", required: false, editable: false }),
    f("sourceRef", "Instance", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [],
  iconKey: "image",
  supportsCreate: true,
  backupRole: {
    role: "snapshot",
    sourceKey: "sourceRef",
    createdKey: "createdAt",
    sizeKey: "sizeGb",
  },
});

export const TemplateResourceType = rt({
  name: "Template",
  id: "template",
  description: "A private Exoscale template",
  fields: [
    f("name", "Name"),
    zone(),
    f("description", "Description", { required: false }),
    f("family", "Family", { required: false, editable: false }),
    f("defaultUser", "Default User", { required: false, editable: false }),
    f("sizeGb", "Size (GB)", { kind: "number", required: false, editable: false }),
    f("bootMode", "Boot Mode", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("templateId", "Template ID", { hidden: true })],
  iconKey: "image",
  supportsCreate: true,
  supportsUpdate: true,
});

export const PrivateNetworkResourceType = rt({
  name: "Private Network",
  id: "private-network",
  description: "An Exoscale private network",
  fields: [
    f("name", "Name"),
    zone(),
    f("description", "Description", { required: false }),
    f("managed", "Managed (DHCP)", { kind: "boolean", required: false, editable: false }),
    f("range", "Address Range", { required: false, editable: false }),
    f("leaseCount", "Attached Instances", { kind: "number", required: false, editable: false }),
    labels(),
  ],
  outputs: [o("networkId", "Network ID", { hidden: true })],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
  attachTargets: [
    { pluginId: "exoscale", resourceTypeId: "instance", matchField: "region", verb: "Attach" },
  ],
});

export const SecurityGroupResourceType = rt({
  name: "Security Group",
  id: "security-group",
  description: "An Exoscale security group (account-wide firewall rules)",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("ruleCount", "Rules", { kind: "number", required: false, editable: false }),
    f("externalSources", "External Sources", { required: false, editable: false }),
    f("openToWorld", "Open to the Internet", {
      required: false,
      editable: false,
      description: "Ingress ports allowed from 0.0.0.0/0 or ::/0 other than 80 and 443",
    }),
  ],
  outputs: [o("securityGroupId", "Security Group ID", { hidden: true })],
  iconKey: "firewall",
  supportsCreate: true,
  attachTargets: [{ pluginId: "exoscale", resourceTypeId: "instance", verb: "Protect" }],
  postureChecks: [
    {
      id: "exoscale-security-group-open-port",
      title: "Security group allows the internet in on more than the web ports",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "openToWorld", when: "notEquals", value: "" }],
      reason: "An ingress rule allows a port other than 80 or 443 from anywhere on the internet.",
    },
  ],
});

export const ElasticIpResourceType = rt({
  name: "Elastic IP",
  id: "elastic-ip",
  description: "An Exoscale elastic IP (optionally health-checked)",
  fields: [
    f("ip", "Address", { editable: false }),
    zone(),
    f("description", "Description", { required: false }),
    f("family", "Family", { required: false, editable: false }),
    f("managed", "Health-checked", { kind: "boolean", required: false, editable: false }),
    f("healthcheck", "Health Check", { required: false, editable: false }),
    f("instanceIds", "Attached Instances", {
      required: false,
      editable: false,
      description:
        "Comma-separated IDs of the instances holding the address; empty when unattached",
    }),
    labels(),
  ],
  outputs: [o("ip", "IP Address")],
  iconKey: "ip",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "instanceIds", when: "equals", value: "" }],
    reason: "Elastic IP is not attached to any instance but is still billed",
  },
  attachTargets: [
    { pluginId: "exoscale", resourceTypeId: "instance", matchField: "region", verb: "Attach" },
  ],
});

export const SksClusterResourceType = rt({
  name: "SKS Cluster",
  id: "sks-cluster",
  description: "An Exoscale Scalable Kubernetes Service cluster",
  fields: [
    f("name", "Name"),
    zone(),
    f("description", "Description", { required: false }),
    f("version", "Kubernetes Version", { editable: false }),
    f("level", "Service Level", { kind: "enum", enumValues: ["starter", "pro"], editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("cni", "CNI", { required: false, editable: false }),
    f("autoUpgrade", "Auto-upgrade", { kind: "boolean", required: false }),
    f("addons", "Add-ons", { required: false, editable: false }),
    f("endpoint", "API Endpoint", { required: false, editable: false }),
    f("allowedNetworks", "API Allowed Networks", {
      required: false,
      description: "Comma-separated CIDRs allowed to reach the API; empty for anywhere",
    }),
    f("nodepoolCount", "Node Pools", { kind: "number", required: false, editable: false }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    labels(),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Admin kubeconfig (valid 30 days)",
    }),
    o("apiEndpoint", "API Endpoint", { hidden: true }),
    o("clusterId", "Cluster ID", { hidden: true }),
    o("clusterRef", "Cluster Reference", { hidden: true }),
  ],
  iconKey: "kubernetes",
  supportsCreate: true,
  supportsUpdate: true,
  credentialFormats: [
    {
      id: "kubeconfig",
      label: "Admin kubeconfig",
      description: "A kubeconfig for the system:masters group, valid for 30 days",
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
});

export const SksNodepoolResourceType = rt({
  name: "SKS Node Pool",
  id: "sks-nodepool",
  pinnable: false,
  description: "A pool of worker nodes in an SKS cluster",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("instanceType", "Instance Type", { required: false, editable: false }),
    f("size", "Nodes", { kind: "number" }),
    f("diskGb", "Disk (GB)", { kind: "number", required: false }),
    f("state", "State", { required: false, editable: false }),
    f("clusterId", "Cluster", { required: false, editable: false }),
    f("region", "Zone", { required: false, editable: false }),
    labels(),
  ],
  outputs: [],
  parentTypeId: "sks-cluster",
  iconKey: "layers",
  supportsCreate: true,
  supportsUpdate: true,
});

export const LoadBalancerResourceType = rt({
  name: "Network Load Balancer",
  id: "nlb",
  description: "An Exoscale Network Load Balancer",
  fields: [
    f("name", "Name"),
    zone(),
    f("description", "Description", { required: false }),
    f("ip", "IP Address", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("serviceCount", "Services", { kind: "number", required: false, editable: false }),
    labels(),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("ipv4", "IP Address")],
  iconKey: "load-balancer",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "serviceCount", when: "equals", value: "0" }],
    reason: "Load balancer has no services, so it serves nothing but is still billed",
  },
});

export const InstancePoolResourceType = rt({
  name: "Instance Pool",
  id: "instance-pool",
  description: "A group of identical Exoscale instances that scales as one",
  fields: [
    f("name", "Name"),
    zone(),
    f("description", "Description", { required: false }),
    f("size", "Instances", { kind: "number" }),
    f("instanceType", "Instance Type", { required: false, editable: false }),
    f("state", "State", { required: false, editable: false }),
    f("managedBy", "Managed By", { required: false, editable: false }),
    labels(),
  ],
  outputs: [o("poolId", "Pool ID", { hidden: true })],
  iconKey: "layers",
  supportsUpdate: true,
});

export const DbaasResourceType = rt({
  name: "Managed Database",
  id: "dbaas",
  description:
    "An Exoscale DBaaS service (PostgreSQL, MySQL, Valkey, Kafka, OpenSearch, Grafana, ClickHouse)",
  fields: [
    f("name", "Name", { editable: false }),
    f("type", "Type", { editable: false }),
    zone(),
    f("plan", "Plan", { description: "Changing the plan resizes the service" }),
    f("state", "State", { required: false, editable: false }),
    f("version", "Version", { required: false, editable: false }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    f("nodeCpus", "vCPUs per Node", { kind: "number", required: false, editable: false }),
    f("nodeMemoryMb", "Memory per Node (MB)", { kind: "number", required: false, editable: false }),
    f("diskGb", "Disk (GB)", { kind: "number", required: false, editable: false }),
    f("ipFilter", "Allowed IPs", {
      required: false,
      description: "Comma-separated CIDRs allowed to connect",
    }),
    f("terminationProtection", "Termination Protection", { kind: "boolean", required: false }),
    f("maintenanceDow", "Maintenance Day", {
      kind: "enum",
      required: false,
      enumValues: [
        "never",
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ],
    }),
    f("maintenanceTime", "Maintenance Time (UTC)", { required: false, description: "HH:MM:SS" }),
    f("backupCount", "Backups", { kind: "number", required: false, editable: false }),
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
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  backupPolicy: { protectedBy: [], automatedBackupFieldKey: "backupCount" },
  postureChecks: [
    {
      id: "exoscale-dbaas-open-to-all",
      title: "Database accepts connections from anywhere",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "ipFilter", when: "equals", value: "0.0.0.0/0" }],
      reason: "The IP filter allows every address to connect.",
    },
    {
      id: "exoscale-dbaas-no-termination-protection",
      title: "Termination protection off",
      severity: "low",
      category: "data-protection",
      conditions: [{ fieldKey: "terminationProtection", when: "falsy" }],
      reason: "The service can be deleted without first turning termination protection off.",
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

export const DbaasUserResourceType = rt({
  name: "Database User",
  id: "dbaas-user",
  pinnable: false,
  description: "A user of an Exoscale DBaaS service",
  fields: [
    f("username", "Username", { editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("service", "Service", { required: false, editable: false }),
  ],
  outputs: [o("password", "Password", { sensitive: true })],
  parentTypeId: "dbaas",
  iconKey: "user",
  supportsCreate: true,
});

export const DbaasDatabaseResourceType = rt({
  name: "Logical Database",
  id: "dbaas-database",
  pinnable: false,
  description: "A database inside an Exoscale PostgreSQL or MySQL service",
  fields: [
    f("name", "Name", { editable: false }),
    f("service", "Service", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "dbaas",
  iconKey: "database",
  supportsCreate: true,
});

export const DnsDomainResourceType = rt({
  name: "DNS Domain",
  id: "dns-domain",
  description: "A domain hosted on Exoscale DNS",
  fields: [
    f("name", "Domain", { editable: false }),
    f("recordCount", "Records", { kind: "number", required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [],
  iconKey: "dns",
  supportsCreate: true,
  dnsRole: { role: "zone", domainKey: "name", recordCountKey: "recordCount" },
});

export const DnsRecordResourceType = rt({
  name: "DNS Record",
  id: "dns-record",
  pinnable: false,
  description: "A record in an Exoscale DNS domain",
  fields: [
    f("type", "Type", { editable: false }),
    f("name", "Name", {
      required: false,
      description: "Relative to the domain; empty for the apex",
    }),
    f("content", "Content"),
    f("ttl", "TTL", { kind: "number", required: false }),
    f("priority", "Priority", { kind: "number", required: false }),
    f("domainName", "Domain", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "dns-domain",
  iconKey: "dns-record",
  supportsCreate: true,
  supportsUpdate: true,
  dnsRole: {
    role: "record",
    nameKey: "name",
    typeKey: "type",
    contentKey: "content",
    ttlKey: "ttl",
    priorityKey: "priority",
    zoneKey: "domainName",
  },
});

export const BucketResourceType = rt({
  name: "SOS Bucket",
  id: "bucket",
  description: "An Exoscale Simple Object Storage bucket",
  fields: [
    f("name", "Name", { editable: false }),
    zone(),
    f("sizeGb", "Stored (GB)", { kind: "number", required: false, editable: false }),
    f("endpoint", "Endpoint", { required: false, editable: false }),
    f("created", "Created", { required: false, editable: false }),
  ],
  outputs: [o("url", "Bucket URL"), o("endpoint", "S3 Endpoint")],
  iconKey: "storage",
  supportsCreate: true,
  supportsStorageBrowser: true,
  dnsServiceHosts: [
    {
      id: "exoscale-sos",
      label: "Exoscale SOS bucket",
      hostPattern: "([a-z0-9][a-z0-9.-]*?)\\.sos-[a-z]{2}-[a-z]{3}-\\d\\.exo\\.io",
      labelIs: "name",
      reason:
        "The record points at an SOS bucket name no synced bucket owns; anyone can create it and serve content from your domain.",
    },
  ],
});

export const SshKeyResourceType = rt({
  name: "SSH Key",
  id: "ssh-key",
  pinnable: false,
  description: "A public SSH key registered with Exoscale",
  fields: [
    f("name", "Name", { editable: false }),
    f("fingerprint", "Fingerprint", { required: false, editable: false }),
  ],
  outputs: [],
  iconKey: "key",
  supportsCreate: true,
});

export const AntiAffinityGroupResourceType = rt({
  name: "Anti-Affinity Group",
  id: "anti-affinity-group",
  pinnable: false,
  description: "Places its instances on different hypervisors",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("instanceCount", "Instances", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("groupId", "Group ID", { hidden: true })],
  iconKey: "layers",
  supportsCreate: true,
});

export const OrganizationResourceType = rt({
  name: "Organization",
  id: "organization",
  description: "The Exoscale organization's balance, quotas and this month's usage",
  fields: [
    f("name", "Name", { required: false }),
    f("balance", "Live Balance", { kind: "number", required: false }),
    f("currency", "Currency", { required: false }),
  ],
  outputs: [],
  iconKey: "account",
  supportsDelete: false,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  InstanceResourceType,
  BlockStorageResourceType,
  BlockStorageSnapshotResourceType,
  SnapshotResourceType,
  TemplateResourceType,
  PrivateNetworkResourceType,
  SecurityGroupResourceType,
  ElasticIpResourceType,
  SksClusterResourceType,
  SksNodepoolResourceType,
  LoadBalancerResourceType,
  InstancePoolResourceType,
  DbaasResourceType,
  DbaasUserResourceType,
  DbaasDatabaseResourceType,
  DnsDomainResourceType,
  DnsRecordResourceType,
  BucketResourceType,
  SshKeyResourceType,
  AntiAffinityGroupResourceType,
  OrganizationResourceType,
];
