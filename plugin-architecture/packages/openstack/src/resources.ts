import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const SERVER = "os-server";
export const FLAVOR = "os-flavor";
export const IMAGE = "os-image";
export const KEYPAIR = "os-keypair";
export const VOLUME = "os-volume";
export const VOLUME_SNAPSHOT = "os-volume-snapshot";
export const VOLUME_BACKUP = "os-volume-backup";
export const NETWORK = "os-network";
export const SUBNET = "os-subnet";
export const ROUTER = "os-router";
export const FLOATING_IP = "os-floating-ip";
export const SECURITY_GROUP = "os-security-group";
export const SG_RULE = "os-security-group-rule";
export const LOADBALANCER = "os-loadbalancer";
export const LB_LISTENER = "os-lb-listener";
export const LB_POOL = "os-lb-pool";
export const CONTAINER = "os-container";
export const DNS_ZONE = "os-dns-zone";
export const DNS_RECORDSET = "os-dns-recordset";
export const STACK = "os-stack";

const ro = { required: false, editable: false } as const;

export const ServerResourceType = rt({
  name: "Server",
  id: SERVER,
  description: "A Nova compute instance",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("status", "Status", {
      kind: "enum",
      enumValues: [
        "ACTIVE",
        "BUILD",
        "SHUTOFF",
        "PAUSED",
        "SUSPENDED",
        "SHELVED",
        "SHELVED_OFFLOADED",
        "RESCUE",
        "RESIZE",
        "VERIFY_RESIZE",
        "REBOOT",
        "HARD_REBOOT",
        "ERROR",
        "DELETED",
        "UNKNOWN",
      ],
      ...ro,
    }),
    f("flavor", "Flavor", { ...ro, description: "Change it with the Resize action" }),
    f("vcpus", "vCPUs", { kind: "number", ...ro }),
    f("ramMb", "RAM (MiB)", { kind: "number", ...ro }),
    f("diskGb", "Root Disk (GiB)", { kind: "number", ...ro }),
    f("imageId", "Image", ro),
    f("keyName", "Key Pair", ro),
    f("availabilityZone", "Availability Zone", ro),
    f("networkNames", "Networks", ro),
    f("networkIds", "Network IDs", ro),
    f("fixedIps", "Fixed IPs", ro),
    f("floatingIps", "Floating IPs", ro),
    f("securityGroups", "Security Groups", ro),
    f("volumeIds", "Attached Volumes", ro),
    f("locked", "Locked", { kind: "boolean", ...ro }),
    f("tags", "Tags", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [
    o("publicIp", "Public IP", { description: "Floating IP if any, otherwise the first address" }),
    o("privateIp", "Private IP"),
    o("serverId", "Server ID"),
  ],
  dependsOn: [
    { fieldKey: "imageId", targetTypeId: IMAGE, label: "booted from" },
    { fieldKey: "keyName", targetTypeId: KEYPAIR, targetKey: "name", label: "uses key" },
    { fieldKey: "networkIds", targetTypeId: NETWORK, label: "attached to" },
    { fieldKey: "volumeIds", targetTypeId: VOLUME, label: "mounts" },
    {
      fieldKey: "securityGroups",
      targetTypeId: SECURITY_GROUP,
      targetKey: "name",
      label: "protected by",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "server",
  lifecycle: {
    startActionId: "start",
    stopActionId: "stop",
    statusFieldKey: "status",
    runningValues: ["ACTIVE"],
    stoppedValues: ["SHUTOFF", "SHELVED_OFFLOADED"],
  },
  sshEndpoint: {
    hostOutputKey: "publicIp",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "status", value: "ACTIVE" },
  },
  agentVm: {
    sshKeyFieldKey: "sshPublicKey",
    defaultUsername: "ubuntu",
    hiddenFieldKeys: ["sshPublicKey"],
  },
});

export const FlavorResourceType = rt({
  name: "Flavor",
  id: FLAVOR,
  description: "A compute size: vCPUs, RAM and disk",
  pinnable: false,
  fields: [
    f("name", "Name", ro),
    f("vcpus", "vCPUs", { kind: "number", ...ro }),
    f("ramMb", "RAM (MiB)", { kind: "number", ...ro }),
    f("diskGb", "Disk (GiB)", { kind: "number", ...ro }),
    f("ephemeralGb", "Ephemeral (GiB)", { kind: "number", ...ro }),
    f("isPublic", "Public", { kind: "boolean", ...ro }),
  ],
  outputs: [o("flavorId", "Flavor ID")],
  supportsDelete: false,
  iconKey: "size",
});

export const ImageResourceType = rt({
  name: "Image",
  id: IMAGE,
  description: "A Glance image",
  fields: [
    f("name", "Name"),
    f("status", "Status", ro),
    f("visibility", "Visibility", {
      kind: "enum",
      enumValues: ["private", "shared", "community", "public"],
      required: false,
    }),
    f("protected", "Protected", { kind: "boolean", required: false }),
    f("osDistro", "OS Distro", ro),
    f("diskFormat", "Disk Format", ro),
    f("sizeGb", "Size (GiB)", { kind: "number", ...ro }),
    f("minDiskGb", "Minimum Disk (GiB)", { kind: "number", required: false }),
    f("minRamMb", "Minimum RAM (MiB)", { kind: "number", required: false }),
    f("owned", "Owned by Project", { kind: "boolean", ...ro }),
    f("imageType", "Type", ro),
    f("sourceServerId", "Snapshot of", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("imageId", "Image ID")],
  dependsOn: [{ fieldKey: "sourceServerId", targetTypeId: SERVER, label: "snapshot of" }],
  supportsUpdate: true,
  pinnable: false,
  iconKey: "image",
  backupRole: {
    role: "snapshot",
    backupTypeKey: "imageType",
    backupTypeValues: ["snapshot"],
    sourceKey: "sourceServerId",
    createdKey: "createdAt",
    sizeKey: "sizeGb",
  },
});

export const KeypairResourceType = rt({
  name: "Key Pair",
  id: KEYPAIR,
  description: "An SSH public key Nova injects into new servers",
  fields: [f("name", "Name", ro), f("type", "Type", ro), f("fingerprint", "Fingerprint", ro)],
  outputs: [o("publicKey", "Public Key")],
  supportsCreate: true,
  pinnable: false,
  iconKey: "key",
});

export const VolumeResourceType = rt({
  name: "Volume",
  id: VOLUME,
  description: "A Cinder block storage volume",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("sizeGb", "Size (GiB)", {
      kind: "number",
      required: false,
      description: "Volumes can only grow",
    }),
    f("status", "Status", ro),
    f("volumeType", "Volume Type", ro),
    f("availabilityZone", "Availability Zone", ro),
    f("bootable", "Bootable", { kind: "boolean", ...ro }),
    f("encrypted", "Encrypted", { kind: "boolean", ...ro }),
    f("serverId", "Attached To", ro),
    f("device", "Device", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("volumeId", "Volume ID")],
  dependsOn: [{ fieldKey: "serverId", targetTypeId: SERVER, label: "attached to" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "volume",
  orphanRule: {
    conditions: [
      { fieldKey: "serverId", when: "empty" },
      { fieldKey: "status", when: "equals", value: "available" },
    ],
    reason: "Volume is not attached to any server",
  },
  attachTargets: [{ pluginId: "openstack", resourceTypeId: SERVER, verb: "Attach" }],
  backupPolicy: { protectedBy: [VOLUME_SNAPSHOT, VOLUME_BACKUP] },
  postureChecks: [
    {
      id: "openstack-volume-unencrypted",
      title: "Volume not encrypted",
      severity: "low",
      category: "encryption",
      conditions: [{ fieldKey: "encrypted", when: "falsy" }],
      reason: "The volume type does not encrypt data at rest.",
    },
  ],
});

export const VolumeSnapshotResourceType = rt({
  name: "Volume Snapshot",
  id: VOLUME_SNAPSHOT,
  description: "A point-in-time Cinder snapshot",
  pinnable: false,
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("status", "Status", ro),
    f("sizeGb", "Size (GiB)", { kind: "number", ...ro }),
    f("volumeId", "Volume", ro),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("snapshotId", "Snapshot ID")],
  dependsOn: [{ fieldKey: "volumeId", targetTypeId: VOLUME, label: "snapshot of" }],
  supportsUpdate: true,
  iconKey: "snapshot",
  backupRole: {
    role: "snapshot",
    sourceKey: "volumeId",
    createdKey: "createdAt",
    sizeKey: "sizeGb",
  },
});

export const VolumeBackupResourceType = rt({
  name: "Volume Backup",
  id: VOLUME_BACKUP,
  description: "A Cinder backup stored outside the volume's backend",
  pinnable: false,
  fields: [
    f("name", "Name", ro),
    f("description", "Description", ro),
    f("status", "Status", ro),
    f("sizeGb", "Size (GiB)", { kind: "number", ...ro }),
    f("volumeId", "Volume", ro),
    f("incremental", "Incremental", { kind: "boolean", ...ro }),
    f("createdAt", "Created", ro),
  ],
  outputs: [o("backupId", "Backup ID")],
  dependsOn: [{ fieldKey: "volumeId", targetTypeId: VOLUME, label: "backup of" }],
  iconKey: "backup",
  backupRole: {
    role: "snapshot",
    sourceKey: "volumeId",
    createdKey: "createdAt",
    sizeKey: "sizeGb",
  },
});

export const NetworkResourceType = rt({
  name: "Network",
  id: NETWORK,
  description: "A Neutron network",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("status", "Status", ro),
    f("adminStateUp", "Admin State Up", { kind: "boolean", required: false }),
    f("mtu", "MTU", { kind: "number", required: false }),
    f("external", "External", { kind: "boolean", ...ro }),
    f("shared", "Shared", { kind: "boolean", ...ro }),
    f("owned", "Owned by Project", { kind: "boolean", ...ro }),
    f("subnetIds", "Subnets", ro),
  ],
  outputs: [o("networkId", "Network ID")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "network",
});

export const SubnetResourceType = rt({
  name: "Subnet",
  id: SUBNET,
  description: "An IP range on a Neutron network",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("cidr", "CIDR", ro),
    f("ipVersion", "IP Version", { kind: "number", ...ro }),
    f("gatewayIp", "Gateway", { required: false }),
    f("enableDhcp", "DHCP", { kind: "boolean", required: false }),
    f("dnsNameservers", "DNS Servers", { required: false, description: "Comma-separated" }),
    f("networkId", "Network", ro),
  ],
  outputs: [o("subnetId", "Subnet ID"), o("cidr", "CIDR")],
  dependsOn: [{ fieldKey: "networkId", targetTypeId: NETWORK, label: "on" }],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "network",
});

export const RouterResourceType = rt({
  name: "Router",
  id: ROUTER,
  description: "A Neutron router connecting subnets and an external gateway",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("status", "Status", ro),
    f("adminStateUp", "Admin State Up", { kind: "boolean", required: false }),
    f("externalNetworkId", "External Gateway", ro),
    f("externalIps", "Gateway IPs", ro),
    f("subnetIds", "Interfaces", ro),
  ],
  outputs: [o("routerId", "Router ID")],
  dependsOn: [
    { fieldKey: "externalNetworkId", targetTypeId: NETWORK, label: "gateway" },
    { fieldKey: "subnetIds", targetTypeId: SUBNET, label: "routes" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "router",
});

export const FloatingIpResourceType = rt({
  name: "Floating IP",
  id: FLOATING_IP,
  description: "A public address from an external network",
  fields: [
    f("ip", "Address", ro),
    f("description", "Description", { required: false }),
    f("status", "Status", ro),
    f("networkId", "Pool Network", ro),
    f("portId", "Port", ro),
    f("fixedIp", "Fixed IP", ro),
    f("serverId", "Server", ro),
    f("dnsName", "DNS Name", ro),
  ],
  outputs: [o("ip", "Address")],
  dependsOn: [
    { fieldKey: "networkId", targetTypeId: NETWORK, label: "from" },
    { fieldKey: "serverId", targetTypeId: SERVER, label: "assigned to" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "ip",
  orphanRule: {
    conditions: [{ fieldKey: "portId", when: "empty" }],
    reason: "Floating IP is not associated with any port",
  },
  attachTargets: [{ pluginId: "openstack", resourceTypeId: SERVER, verb: "Associate" }],
});

export const SecurityGroupResourceType = rt({
  name: "Security Group",
  id: SECURITY_GROUP,
  description: "A set of Neutron firewall rules applied to ports",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("stateful", "Stateful", { kind: "boolean", ...ro }),
    f("ruleCount", "Rules", { kind: "number", ...ro }),
  ],
  outputs: [o("securityGroupId", "Security Group ID")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "firewall",
  attachTargets: [{ pluginId: "openstack", resourceTypeId: SERVER, verb: "Apply" }],
});

export const SecurityGroupRuleResourceType = rt({
  name: "Security Group Rule",
  id: SG_RULE,
  description: "One rule of a security group",
  parentTypeId: SECURITY_GROUP,
  pinnable: false,
  fields: [
    f("direction", "Direction", { kind: "enum", enumValues: ["ingress", "egress"], ...ro }),
    f("ethertype", "Ether Type", { kind: "enum", enumValues: ["IPv4", "IPv6"], ...ro }),
    f("protocol", "Protocol", ro),
    f("portRangeMin", "Port From", { kind: "number", ...ro }),
    f("portRangeMax", "Port To", { kind: "number", ...ro }),
    f("remoteIpPrefix", "Remote CIDR", ro),
    f("remoteGroupId", "Remote Group", ro),
    f("description", "Description", ro),
    f("securityGroupId", "Security Group", ro),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "securityGroupId", targetTypeId: SECURITY_GROUP, label: "rule of" }],
  supportsCreate: true,
  iconKey: "firewall",
  postureChecks: [
    {
      id: "openstack-sg-ssh-open",
      title: "SSH open to the internet",
      severity: "high",
      category: "public-exposure",
      conditions: [
        { fieldKey: "direction", when: "equals", value: "ingress" },
        { fieldKey: "remoteIpPrefix", when: "equals", value: "0.0.0.0/0" },
        { fieldKey: "portRangeMin", when: "equals", value: "22" },
      ],
      reason: "An ingress rule admits SSH (port 22) from any IPv4 address.",
    },
    {
      id: "openstack-sg-all-ports-open",
      title: "All ports open to the internet",
      severity: "critical",
      category: "public-exposure",
      conditions: [
        { fieldKey: "direction", when: "equals", value: "ingress" },
        { fieldKey: "remoteIpPrefix", when: "equals", value: "0.0.0.0/0" },
        { fieldKey: "protocol", when: "empty" },
      ],
      reason: "An ingress rule admits every protocol and port from any IPv4 address.",
    },
  ],
});

export const LoadBalancerResourceType = rt({
  name: "Load Balancer",
  id: LOADBALANCER,
  description: "An Octavia load balancer",
  fields: [
    f("name", "Name"),
    f("description", "Description", { required: false }),
    f("provisioningStatus", "Provisioning", ro),
    f("operatingStatus", "Operating", ro),
    f("vipAddress", "VIP Address", ro),
    f("vipSubnetId", "VIP Subnet", ro),
    f("vipPortId", "VIP Port", ro),
    f("provider", "Provider", ro),
    f("adminStateUp", "Admin State Up", { kind: "boolean", required: false }),
    f("listenerIds", "Listeners", ro),
    f("poolIds", "Pools", ro),
  ],
  outputs: [o("vipAddress", "VIP Address"), o("loadBalancerId", "Load Balancer ID")],
  dependsOn: [{ fieldKey: "vipSubnetId", targetTypeId: SUBNET, label: "VIP on" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "load-balancer",
});

export const LbListenerResourceType = rt({
  name: "Listener",
  id: LB_LISTENER,
  description: "A protocol and port an Octavia load balancer accepts",
  parentTypeId: LOADBALANCER,
  pinnable: false,
  fields: [
    f("name", "Name"),
    f("protocol", "Protocol", ro),
    f("port", "Port", { kind: "number", ...ro }),
    f("defaultPoolId", "Default Pool", ro),
    f("connectionLimit", "Connection Limit", {
      kind: "number",
      required: false,
      description: "-1 is unlimited",
    }),
    f("adminStateUp", "Admin State Up", { kind: "boolean", required: false }),
    f("provisioningStatus", "Provisioning", ro),
    f("operatingStatus", "Operating", ro),
    f("loadBalancerId", "Load Balancer", ro),
  ],
  outputs: [],
  dependsOn: [
    { fieldKey: "loadBalancerId", targetTypeId: LOADBALANCER, label: "on" },
    { fieldKey: "defaultPoolId", targetTypeId: LB_POOL, label: "forwards to" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "load-balancer",
});

export const LbPoolResourceType = rt({
  name: "Pool",
  id: LB_POOL,
  description: "A group of backend members behind an Octavia listener",
  parentTypeId: LOADBALANCER,
  pinnable: false,
  fields: [
    f("name", "Name"),
    f("protocol", "Protocol", ro),
    f("lbAlgorithm", "Algorithm", {
      kind: "enum",
      enumValues: ["ROUND_ROBIN", "LEAST_CONNECTIONS", "SOURCE_IP", "SOURCE_IP_PORT"],
      required: false,
    }),
    f("memberCount", "Members", { kind: "number", ...ro }),
    f("healthMonitorId", "Health Monitor", ro),
    f("provisioningStatus", "Provisioning", ro),
    f("operatingStatus", "Operating", ro),
    f("loadBalancerId", "Load Balancer", ro),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "loadBalancerId", targetTypeId: LOADBALANCER, label: "on" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "load-balancer",
});

export const ContainerResourceType = rt({
  name: "Container",
  id: CONTAINER,
  description: "A Swift object storage container",
  fields: [
    f("name", "Name", ro),
    f("objectCount", "Objects", { kind: "number", ...ro }),
    f("sizeGb", "Size (GiB)", { kind: "number", ...ro }),
    f("publicRead", "Public Read", {
      kind: "boolean",
      required: false,
      description: "Sets the container read ACL to .r:*,.rlistings",
    }),
    f("lastModified", "Last Modified", ro),
  ],
  outputs: [o("url", "Container URL")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsStorageBrowser: true,
  iconKey: "bucket",
  postureChecks: [
    {
      id: "openstack-container-public",
      title: "Container is publicly readable",
      severity: "high",
      category: "public-exposure",
      conditions: [{ fieldKey: "publicRead", when: "truthy" }],
      reason: "Anyone with the URL can read every object in this container.",
    },
  ],
});

export const DnsZoneResourceType = rt({
  name: "DNS Zone",
  id: DNS_ZONE,
  description: "A Designate DNS zone",
  fields: [
    f("name", "Domain", ro),
    f("email", "Email"),
    f("ttl", "Default TTL", { kind: "number", required: false }),
    f("description", "Description", { required: false }),
    f("status", "Status", ro),
    f("type", "Type", { kind: "enum", enumValues: ["PRIMARY", "SECONDARY"], ...ro }),
    f("serial", "Serial", { kind: "number", ...ro }),
  ],
  outputs: [o("zoneId", "Zone ID")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "dns",
  dnsRole: { role: "zone", domainKey: "name", statusKey: "status" },
});

export const DnsRecordsetResourceType = rt({
  name: "Record Set",
  id: DNS_RECORDSET,
  description: "A Designate record set (name, type and records)",
  parentTypeId: DNS_ZONE,
  pinnable: false,
  fields: [
    f("name", "Name", ro),
    f("type", "Type", ro),
    f("content", "Records", { description: "Comma-separated record values" }),
    f("ttl", "TTL", { kind: "number", required: false }),
    f("description", "Description", { required: false }),
    f("status", "Status", ro),
    f("zoneId", "Zone", ro),
  ],
  outputs: [],
  dependsOn: [{ fieldKey: "zoneId", targetTypeId: DNS_ZONE, label: "in" }],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "dns",
  dnsRole: {
    role: "record",
    nameKey: "name",
    typeKey: "type",
    contentKey: "content",
    ttlKey: "ttl",
    zoneKey: "zoneId",
  },
});

export const StackResourceType = rt({
  name: "Stack",
  id: STACK,
  description: "A Heat orchestration stack",
  fields: [
    f("name", "Name", ro),
    f("status", "Status", ro),
    f("statusReason", "Status Reason", ro),
    f("description", "Description", ro),
    f("createdAt", "Created", ro),
    f("updatedAt", "Updated", ro),
  ],
  outputs: [o("stackId", "Stack ID")],
  supportsCreate: true,
  iconKey: "stack",
});

export const resourceTypes: ResourceTypeDefinition[] = [
  ServerResourceType,
  FlavorResourceType,
  ImageResourceType,
  KeypairResourceType,
  VolumeResourceType,
  VolumeSnapshotResourceType,
  VolumeBackupResourceType,
  NetworkResourceType,
  SubnetResourceType,
  RouterResourceType,
  FloatingIpResourceType,
  SecurityGroupResourceType,
  SecurityGroupRuleResourceType,
  LoadBalancerResourceType,
  LbListenerResourceType,
  LbPoolResourceType,
  ContainerResourceType,
  DnsZoneResourceType,
  DnsRecordsetResourceType,
  StackResourceType,
];
