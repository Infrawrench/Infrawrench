import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * Resource types. Regional resources use `{regionCode}/{uuid}` as their
 * external id because every Civo call needs the region; node pools and
 * database backups add the parent (`{region}/{cluster}/{pool}`), and DNS
 * records are `{domainId}/{recordId}`. SSH keys and DNS domains are
 * account-wide and use the bare UUID.
 *
 * Billing facts (civo.com/pricing, checked 2026-10): instances, volumes,
 * load balancers, reserved IPs and object stores bill hourly while they
 * exist; a shut-off instance is still billed.
 */

const region = () => f("region", "Region", { editable: false });
const created = () => f("created", "Created", { required: false, editable: false });

export const InstanceResourceType = rt({
  name: "Instance",
  id: "instance",
  description: "A Civo compute instance",
  fields: [
    f("hostname", "Hostname"),
    f("status", "Status", { required: false, editable: false }),
    f("size", "Size", {
      description: "Civo size, e.g. g3.small. Changing it resizes the instance (upsize only)",
    }),
    region(),
    f("diskImage", "Disk Image", { required: false, editable: false }),
    f("cpuCores", "vCPUs", { kind: "number", required: false, editable: false }),
    f("ramMb", "Memory (MB)", { kind: "number", required: false, editable: false }),
    f("diskGb", "Disk (GB)", { kind: "number", required: false, editable: false }),
    f("gpu", "GPU", { required: false, editable: false }),
    f("initialUser", "Initial User", { required: false, editable: false }),
    f("firewallId", "Firewall", { required: false, editable: false }),
    f("networkId", "Network", { required: false, editable: false }),
    f("reservedIp", "Reserved IP", { required: false, editable: false }),
    f("reverseDns", "Reverse DNS", { required: false }),
    f("notes", "Notes", { required: false }),
    f("allowedIps", "Allowed IPs", {
      required: false,
      description:
        "Comma-separated source addresses allowed to reach the instance (Civo's anti-spoofing list)",
    }),
    f("bandwidthLimit", "Bandwidth Limit (Mbps)", {
      kind: "number",
      required: false,
      description: "0 means unlimited",
    }),
    f("tags", "Tags", { required: false, description: "Space or comma separated tags" }),
    created(),
  ],
  outputs: [
    o("ipv4", "Public IPv4"),
    o("ipv4Private", "Private IPv4"),
    o("ipv6", "IPv6"),
    o("instanceId", "Instance ID", { hidden: true }),
    o("instanceRef", "Instance Reference", { hidden: true }),
    o("initialPassword", "Initial Password", {
      sensitive: true,
      description: "Password Civo generated for the initial user",
    }),
  ],
  dependsOn: [
    {
      fieldKey: "firewallId",
      targetTypeId: "firewall",
      targetKey: "firewallId",
      label: "protected by",
    },
    { fieldKey: "networkId", targetTypeId: "network", targetKey: "networkId", label: "in" },
  ],
  iconKey: "server",
  supportsCreate: true,
  supportsUpdate: true,
  sshEndpoint: {
    hostOutputKey: "ipv4",
    privateHostOutputKey: "ipv4Private",
    runningWhen: { fieldKey: "status", value: "ACTIVE" },
    defaultUsername: "civo",
    usernameFieldKey: "initialUser",
  },
  agentVm: {
    sshKeyFieldKey: "sshPublicKey",
    defaultUsername: "civo",
    defaultFields: { size: "g3.medium" },
    hiddenFieldKeys: ["sshPublicKey", "script"],
  },
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "status",
    runningValues: ["ACTIVE"],
    stoppedValues: ["SHUTOFF"],
  },
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "SHUTOFF" }],
    reason: "Instance is shut off but Civo still bills it; only deleting it stops the charges",
  },
  carbon: { regionFieldKey: "region", vcpus: { from: "field", fieldKey: "cpuCores" } },
  postureChecks: [
    {
      id: "civo-instance-default-firewall",
      title: "No firewall attached",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "firewallId", when: "equals", value: "" }],
      reason:
        "The instance has no firewall, so every port it listens on is reachable from the internet.",
    },
  ],
});

export const VolumeResourceType = rt({
  name: "Volume",
  id: "volume",
  description: "A Civo block storage volume",
  fields: [
    f("name", "Name", { editable: false }),
    f("sizeGb", "Size (GB)", { kind: "number", description: "Volumes can grow but never shrink" }),
    region(),
    f("status", "Status", { required: false, editable: false }),
    f("volumeType", "Type", { required: false, editable: false }),
    f("instanceId", "Attached Instance", {
      required: false,
      editable: false,
      description: "ID of the instance the volume is attached to; empty when detached",
    }),
    f("clusterId", "Kubernetes Cluster", { required: false, editable: false }),
    f("mountPoint", "Mount Point", { required: false, editable: false }),
    f("networkId", "Network", { required: false, editable: false }),
    created(),
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
    {
      fieldKey: "clusterId",
      targetTypeId: "kubernetes-cluster",
      targetKey: "clusterId",
      label: "used by",
    },
  ],
  iconKey: "volume",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [
      { fieldKey: "instanceId", when: "equals", value: "" },
      { fieldKey: "clusterId", when: "equals", value: "" },
    ],
    reason: "Volume is not attached to an instance or cluster but is still billed per GB",
  },
  attachTargets: [
    { pluginId: "civo", resourceTypeId: "instance", matchField: "region", verb: "Attach" },
  ],
  backupPolicy: { protectedBy: ["volume-snapshot"] },
});

export const VolumeSnapshotResourceType = rt({
  name: "Volume Snapshot",
  id: "volume-snapshot",
  description: "A point-in-time snapshot of a Civo volume",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false, editable: false }),
    f("volumeId", "Volume", { required: false, editable: false }),
    f("sourceVolumeName", "Source Volume", { required: false, editable: false }),
    f("sourceRef", "Source", {
      required: false,
      editable: false,
      description: "External id of the protected resource",
    }),
    f("state", "State", { required: false, editable: false }),
    f("sizeGb", "Size (GB)", { kind: "number", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    region(),
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "volumeId", targetTypeId: "volume", targetKey: "volumeId", label: "snapshot of" },
  ],
  iconKey: "image",
  supportsCreate: true,
  backupRole: {
    role: "snapshot",
    sourceKey: "sourceRef",
    createdKey: "createdAt",
    sizeKey: "sizeGb",
  },
});

export const InstanceSnapshotResourceType = rt({
  name: "Instance Snapshot",
  id: "instance-snapshot",
  description: "A snapshot of a Civo instance (and optionally its volumes)",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("instanceId", "Instance", { required: false, editable: false }),
    f("sourceRef", "Source", {
      required: false,
      editable: false,
      description: "External id of the protected resource",
    }),
    f("state", "State", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    region(),
  ],
  outputs: [],
  dependsOn: [
    {
      fieldKey: "instanceId",
      targetTypeId: "instance",
      targetKey: "instanceId",
      label: "snapshot of",
    },
  ],
  iconKey: "image",
  supportsCreate: true,
  supportsUpdate: true,
  backupRole: { role: "snapshot", sourceKey: "sourceRef", createdKey: "createdAt" },
});

export const KubernetesClusterResourceType = rt({
  name: "Kubernetes Cluster",
  id: "kubernetes-cluster",
  description: "A Civo Kubernetes (K3s or Talos) cluster",
  fields: [
    f("name", "Name"),
    region(),
    f("version", "Kubernetes Version", { editable: false }),
    f("upgradeAvailableTo", "Upgrade Available", { required: false, editable: false }),
    f("clusterType", "Distribution", { required: false, editable: false }),
    f("cniPlugin", "CNI", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("nodeCount", "Nodes", { kind: "number", required: false, editable: false }),
    f("nodeSize", "Node Size", { required: false, editable: false }),
    f("poolCount", "Node Pools", { kind: "number", required: false, editable: false }),
    f("apiEndpoint", "API Endpoint", { required: false, editable: false }),
    f("masterIp", "Control Plane IP", { required: false, editable: false }),
    f("firewallId", "Firewall", { required: false, editable: false }),
    f("networkId", "Network", { required: false, editable: false }),
    f("applications", "Installed Applications", { required: false, editable: false }),
    f("tags", "Tags", { required: false }),
    created(),
  ],
  outputs: [
    o("kubeconfig", "Kubeconfig", {
      sensitive: true,
      hidden: true,
      description: "Kubeconfig YAML",
    }),
    o("apiEndpoint", "API Endpoint", { hidden: true }),
    o("clusterId", "Cluster ID", { hidden: true }),
    o("clusterRef", "Cluster Reference", { hidden: true }),
  ],
  dependsOn: [
    {
      fieldKey: "firewallId",
      targetTypeId: "firewall",
      targetKey: "firewallId",
      label: "protected by",
    },
    { fieldKey: "networkId", targetTypeId: "network", targetKey: "networkId", label: "in" },
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
      catalogueFieldKey: "size",
      sizeFieldKey: "nodeSize",
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
      id: "civo-kubeconfig",
      displayName: "Civo Kubeconfig",
      description: "Kubeconfig for kubectl access to this cluster",
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
  description: "A pool of identical nodes in a Civo Kubernetes cluster",
  fields: [
    f("poolId", "Pool", { editable: false }),
    f("size", "Node Size", { editable: false }),
    f("count", "Nodes", { kind: "number", description: "1 or more nodes" }),
    f("publicIpNodePool", "Public IP Nodes", { kind: "boolean", required: false, editable: false }),
    f("nodesActive", "Active Nodes", { kind: "number", required: false, editable: false }),
    f("clusterId", "Cluster", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "kubernetes-cluster",
  dependsOn: [
    {
      fieldKey: "clusterId",
      targetTypeId: "kubernetes-cluster",
      targetKey: "clusterId",
      label: "pool of",
    },
  ],
  iconKey: "layers",
  supportsCreate: true,
  supportsUpdate: true,
  carbon: {
    role: "aggregate",
    regionFieldKey: "region",
    vcpus: {
      from: "size",
      catalogueTypeId: "instance",
      catalogueFieldKey: "size",
      sizeFieldKey: "size",
    },
    countFieldKey: "count",
  },
});

export const DatabaseResourceType = rt({
  name: "Database",
  id: "database",
  description: "A Civo managed database (MySQL or PostgreSQL)",
  fields: [
    f("name", "Name"),
    f("engine", "Engine", { kind: "enum", enumValues: ["MySQL", "PostgreSQL"], editable: false }),
    f("version", "Version", { editable: false }),
    region(),
    f("status", "Status", { required: false, editable: false }),
    f("size", "Size", { editable: false }),
    f("nodes", "Nodes", {
      kind: "number",
      description: "1 node, or more for a highly available replica set",
    }),
    f("host", "Host", { required: false, editable: false }),
    f("privateHost", "Private Host", { required: false, editable: false }),
    f("port", "Port", { kind: "number", required: false, editable: false }),
    f("firewallId", "Firewall", { required: false, editable: false }),
    f("networkId", "Network", { required: false, editable: false }),
  ],
  outputs: [
    o("connectionString", "Connection String", {
      sensitive: true,
      description: "Full connection URI",
    }),
    o("host", "Host"),
    o("port", "Port"),
    o("username", "Username"),
    o("password", "Password", { sensitive: true }),
    o("database", "Database Name"),
    o("databaseId", "Database ID", { hidden: true }),
    o("databaseRef", "Database Reference", { hidden: true }),
  ],
  dependsOn: [
    {
      fieldKey: "firewallId",
      targetTypeId: "firewall",
      targetKey: "firewallId",
      label: "protected by",
    },
    { fieldKey: "networkId", targetTypeId: "network", targetKey: "networkId", label: "in" },
  ],
  iconKey: "database",
  supportsCreate: true,
  supportsUpdate: true,
  backupPolicy: { protectedBy: ["database-backup"] },
  peerIntegrations: [
    {
      pluginId: "postgres",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "PostgreSQL",
      showWhen: { fieldKey: "engine", equals: "PostgreSQL" },
    },
    {
      pluginId: "mysql",
      credentialMappings: [{ outputKey: "connectionString", credentialKey: "connectionString" }],
      tabLabel: "MySQL",
      showWhen: { fieldKey: "engine", equals: "MySQL" },
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

export const DatabaseBackupResourceType = rt({
  name: "Database Backup",
  id: "database-backup",
  pinnable: false,
  description: "A manual or scheduled backup of a Civo database",
  fields: [
    f("name", "Name", { editable: false }),
    f("schedule", "Schedule", {
      required: false,
      description: "Cron expression for scheduled backups",
    }),
    f("scheduled", "Scheduled", { kind: "boolean", required: false, editable: false }),
    f("sourceRef", "Source", {
      required: false,
      editable: false,
      description: "External id of the protected resource",
    }),
    f("status", "Status", { required: false, editable: false }),
    f("databaseId", "Database", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("region", "Region", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "database",
  dependsOn: [
    {
      fieldKey: "databaseId",
      targetTypeId: "database",
      targetKey: "databaseId",
      label: "backup of",
    },
  ],
  iconKey: "archive",
  supportsCreate: true,
  supportsUpdate: true,
  backupRole: { role: "snapshot", sourceKey: "sourceRef", createdKey: "createdAt" },
});

export const LoadBalancerResourceType = rt({
  name: "Load Balancer",
  id: "load-balancer",
  description: "A Civo load balancer",
  fields: [
    f("name", "Name"),
    region(),
    f("state", "State", { required: false, editable: false }),
    f("algorithm", "Algorithm", {
      kind: "enum",
      required: false,
      enumValues: ["round_robin", "least_connections"],
    }),
    f("publicIp", "Public IP", { required: false, editable: false }),
    f("privateIp", "Private IP", { required: false, editable: false }),
    f("backendCount", "Backends", { kind: "number", required: false, editable: false }),
    f("backends", "Backend Addresses", { required: false, editable: false }),
    f("externalTrafficPolicy", "External Traffic Policy", {
      kind: "enum",
      required: false,
      enumValues: ["Cluster", "Local"],
    }),
    f("sessionAffinity", "Session Affinity", {
      kind: "enum",
      required: false,
      enumValues: ["None", "ClientIP"],
    }),
    f("proxyProtocol", "Proxy Protocol", {
      kind: "enum",
      required: false,
      enumValues: ["", "send", "send-v2"],
    }),
    f("maxConcurrentRequests", "Max Concurrent Requests", { kind: "number", required: false }),
    f("clusterId", "Kubernetes Cluster", { required: false, editable: false }),
    f("firewallId", "Firewall", { required: false, editable: false }),
    f("networkId", "Network", { required: false, editable: false }),
  ],
  outputs: [o("ipv4", "Public IP")],
  dependsOn: [
    {
      fieldKey: "clusterId",
      targetTypeId: "kubernetes-cluster",
      targetKey: "clusterId",
      label: "serves",
    },
    {
      fieldKey: "firewallId",
      targetTypeId: "firewall",
      targetKey: "firewallId",
      label: "protected by",
    },
  ],
  iconKey: "load-balancer",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [
      { fieldKey: "backendCount", when: "equals", value: "0" },
      { fieldKey: "clusterId", when: "equals", value: "" },
    ],
    reason: "Load balancer has no backends, so it serves nothing but is still billed",
  },
});

export const FirewallResourceType = rt({
  name: "Firewall",
  id: "firewall",
  description: "A Civo firewall (ingress and egress rules for a network)",
  fields: [
    f("name", "Name"),
    region(),
    f("networkId", "Network", { required: false, editable: false }),
    f("rulesCount", "Rules", { kind: "number", required: false, editable: false }),
    f("instanceCount", "Instances", { kind: "number", required: false, editable: false }),
    f("clusterCount", "Clusters", { kind: "number", required: false, editable: false }),
    f("loadBalancerCount", "Load Balancers", { kind: "number", required: false, editable: false }),
    f("openToWorld", "Open to the Internet", {
      required: false,
      editable: false,
      description: "Ingress ports allowed from 0.0.0.0/0 other than 80 and 443",
    }),
  ],
  outputs: [o("firewallId", "Firewall ID", { hidden: true })],
  dependsOn: [
    { fieldKey: "networkId", targetTypeId: "network", targetKey: "networkId", label: "in" },
  ],
  iconKey: "firewall",
  supportsCreate: true,
  supportsUpdate: true,
  attachTargets: [
    { pluginId: "civo", resourceTypeId: "instance", matchField: "region", verb: "Protect" },
  ],
  postureChecks: [
    {
      id: "civo-firewall-open-port",
      title: "Firewall allows the internet in on more than the web ports",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "openToWorld", when: "notEquals", value: "" }],
      reason:
        "An ingress rule allows a port other than 80 or 443 from 0.0.0.0/0 (Civo's default firewall opens every port).",
    },
  ],
});

export const NetworkResourceType = rt({
  name: "Network",
  id: "network",
  description: "A Civo private network",
  fields: [
    f("label", "Label"),
    region(),
    f("cidr", "IPv4 Range", { required: false, editable: false }),
    f("default", "Default Network", { kind: "boolean", required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("nameservers", "Nameservers", { required: false, editable: false }),
    f("freeIps", "Free IPs", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("networkId", "Network ID", { hidden: true })],
  iconKey: "network",
  supportsCreate: true,
  supportsUpdate: true,
});

export const ReservedIpResourceType = rt({
  name: "Reserved IP",
  id: "reserved-ip",
  description: "A reserved public IPv4 address",
  fields: [
    f("name", "Name"),
    f("address", "Address", { required: false, editable: false }),
    region(),
    f("assignedToId", "Assigned To", {
      required: false,
      editable: false,
      description: "ID of the instance or load balancer using the address; empty when unassigned",
    }),
    f("assignedToType", "Assigned Type", { required: false, editable: false }),
    f("assignedToName", "Assigned Name", { required: false, editable: false }),
  ],
  outputs: [o("ip", "IP Address")],
  dependsOn: [
    {
      fieldKey: "assignedToId",
      targetTypeId: "instance",
      targetKey: "instanceId",
      label: "assigned to",
    },
  ],
  iconKey: "ip",
  supportsCreate: true,
  supportsUpdate: true,
  orphanRule: {
    conditions: [{ fieldKey: "assignedToId", when: "equals", value: "" }],
    reason: "Reserved IP is not assigned to anything but is still billed",
  },
  attachTargets: [
    { pluginId: "civo", resourceTypeId: "instance", matchField: "region", verb: "Assign" },
  ],
});

export const DomainResourceType = rt({
  name: "DNS Domain",
  id: "domain",
  description: "A domain hosted on Civo DNS",
  fields: [
    f("name", "Domain"),
    f("recordCount", "Records", { kind: "number", required: false, editable: false }),
  ],
  outputs: [o("nameservers", "Nameservers")],
  iconKey: "dns",
  supportsCreate: true,
  supportsUpdate: true,
  dnsRole: { role: "zone", domainKey: "name", recordCountKey: "recordCount" },
});

export const DnsRecordResourceType = rt({
  name: "DNS Record",
  id: "dns-record",
  pinnable: false,
  description: "A record in a Civo DNS domain",
  fields: [
    f("type", "Type", {
      kind: "enum",
      enumValues: ["A", "CNAME", "MX", "SRV", "TXT", "NS"],
      editable: false,
    }),
    f("name", "Name", { description: "Relative to the domain; @ for the apex" }),
    f("value", "Value"),
    f("ttl", "TTL", { kind: "number", required: false }),
    f("priority", "Priority", { kind: "number", required: false }),
    f("domainName", "Domain", { required: false, editable: false }),
  ],
  outputs: [],
  parentTypeId: "domain",
  iconKey: "dns-record",
  supportsCreate: true,
  supportsUpdate: true,
  dnsRole: {
    role: "record",
    nameKey: "name",
    typeKey: "type",
    contentKey: "value",
    ttlKey: "ttl",
    priorityKey: "priority",
    zoneKey: "domainName",
  },
});

export const ObjectStoreResourceType = rt({
  name: "Object Store",
  id: "object-store",
  description: "A Civo Object Store (an S3-compatible bucket)",
  fields: [
    f("name", "Name", { editable: false }),
    region(),
    f("maxSizeGb", "Size (GB)", {
      kind: "number",
      description: "Billed in 500 GB blocks; can grow",
    }),
    f("status", "Status", { required: false, editable: false }),
    f("endpoint", "Endpoint", { required: false, editable: false }),
    f("credentialId", "Credential", { required: false, editable: false }),
    f("accessKeyId", "Access Key ID", { required: false, editable: false }),
  ],
  outputs: [
    o("endpoint", "S3 Endpoint"),
    o("bucketUrl", "Bucket URL"),
    o("accessKey", "Access Key"),
    o("secretKey", "Secret Key", { sensitive: true }),
  ],
  dependsOn: [
    {
      fieldKey: "credentialId",
      targetTypeId: "object-store-credential",
      targetKey: "credentialId",
      label: "owned by",
    },
  ],
  iconKey: "storage",
  supportsCreate: true,
  supportsUpdate: true,
  supportsStorageBrowser: true,
  secretExportTemplates: [
    {
      id: "s3-credentials",
      displayName: "S3 credentials",
      description: "Endpoint and keys for any S3-compatible client",
      entries: [
        { envKey: "AWS_ENDPOINT_URL", outputKey: "endpoint" },
        { envKey: "AWS_ACCESS_KEY_ID", outputKey: "accessKey" },
        { envKey: "AWS_SECRET_ACCESS_KEY", outputKey: "secretKey" },
      ],
    },
  ],
});

export const ObjectStoreCredentialResourceType = rt({
  name: "Object Store Credential",
  id: "object-store-credential",
  description: "An access key pair for Civo Object Stores",
  fields: [
    f("name", "Name", { editable: false }),
    region(),
    f("accessKeyId", "Access Key ID", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("suspended", "Suspended", { kind: "boolean", required: false, editable: false }),
  ],
  outputs: [
    o("credentialId", "Credential ID", { hidden: true }),
    o("accessKey", "Access Key"),
    o("secretKey", "Secret Key", { sensitive: true }),
  ],
  iconKey: "key",
  supportsCreate: true,
});

export const SshKeyResourceType = rt({
  name: "SSH Key",
  id: "ssh-key",
  pinnable: false,
  description: "A public SSH key stored in the Civo account",
  fields: [
    f("name", "Name"),
    f("fingerprint", "Fingerprint", { required: false, editable: false }),
    f("publicKey", "Public Key", { required: false, editable: false }),
    created(),
  ],
  outputs: [o("sshKeyId", "SSH Key ID", { hidden: true })],
  iconKey: "key",
  supportsCreate: true,
  supportsUpdate: true,
  expiryFields: [{ fieldKey: "created", from: "created", kind: "ssh-key", label: "SSH key age" }],
});

export const AccountResourceType = rt({
  name: "Account",
  id: "account",
  description: "The Civo account's quota usage and this month's metered usage",
  fields: [
    f("email", "Email", { required: false }),
    f("instances", "Instances", { required: false }),
    f("cpuCores", "vCPUs", { required: false }),
    f("ramMb", "Memory (MB)", { required: false }),
    f("diskGb", "Disk (GB)", { required: false }),
    f("publicIps", "Public IPs", { required: false }),
    f("loadBalancers", "Load Balancers", { required: false }),
    f("objectStoreGb", "Object Store (GB)", { required: false }),
    f("databases", "Databases", { required: false }),
  ],
  outputs: [],
  iconKey: "account",
  supportsDelete: false,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  InstanceResourceType,
  VolumeResourceType,
  VolumeSnapshotResourceType,
  InstanceSnapshotResourceType,
  KubernetesClusterResourceType,
  NodePoolResourceType,
  DatabaseResourceType,
  DatabaseBackupResourceType,
  LoadBalancerResourceType,
  FirewallResourceType,
  NetworkResourceType,
  ReservedIpResourceType,
  DomainResourceType,
  DnsRecordResourceType,
  ObjectStoreResourceType,
  ObjectStoreCredentialResourceType,
  SshKeyResourceType,
  AccountResourceType,
];
