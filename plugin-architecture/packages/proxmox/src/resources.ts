import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

export const CLUSTER = "pve-cluster";
export const NODE = "pve-node";
export const VM = "pve-vm";
export const CT = "pve-ct";
export const STORAGE = "pve-storage";
export const BACKUP = "pve-backup";
export const BACKUP_JOB = "pve-backup-job";
export const POOL = "pve-pool";
export const HA_RESOURCE = "pve-ha-resource";
export const HA_RULE = "pve-ha-rule";
export const FW_RULE = "pve-firewall-rule";
export const SECURITY_GROUP = "pve-security-group";
export const FW_ALIAS = "pve-firewall-alias";
export const IPSET = "pve-ipset";

const ro = { required: false, editable: false } as const;

export const ClusterResourceType = rt({
  name: "Cluster",
  id: CLUSTER,
  description:
    "The Proxmox VE cluster (or standalone node) behind this account: quorum, HA manager state, firewall and guests without a backup job",
  fields: [
    f("name", "Name", ro),
    f("quorate", "Quorate", { kind: "boolean", ...ro }),
    f("nodeCount", "Nodes", { kind: "number", ...ro }),
    f("onlineNodes", "Online Nodes", { kind: "number", ...ro }),
    f("pveVersion", "Proxmox VE Version", ro),
    f("firewallEnabled", "Datacenter Firewall", {
      kind: "boolean",
      required: false,
      description: "Whether the datacenter-wide firewall is enabled",
    }),
    f("firewallPolicyIn", "Default Inbound Policy", {
      kind: "enum",
      enumValues: ["ACCEPT", "REJECT", "DROP"],
      required: false,
    }),
    f("firewallPolicyOut", "Default Outbound Policy", {
      kind: "enum",
      enumValues: ["ACCEPT", "REJECT", "DROP"],
      required: false,
    }),
  ],
  outputs: [o("apiUrl", "API URL")],
  supportsUpdate: true,
  supportsDelete: false,
  iconKey: "cluster",
  postureChecks: [
    {
      id: "pve-datacenter-firewall-disabled",
      title: "Datacenter firewall disabled",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "firewallEnabled", when: "falsy" }],
      reason:
        "The datacenter-level firewall is off, so no cluster, node or guest firewall rule is enforced anywhere in the cluster.",
    },
  ],
});

export const NodeResourceType = rt({
  name: "Node",
  id: NODE,
  description: "A Proxmox VE host in the cluster",
  fields: [
    f("name", "Name", ro),
    f("status", "Status", { kind: "enum", enumValues: ["online", "offline", "unknown"], ...ro }),
    f("ip", "IP Address", ro),
    f("cpuModel", "CPU", ro),
    f("cpuCount", "CPU Threads", { kind: "number", ...ro }),
    f("memoryGb", "Memory (GiB)", { kind: "number", ...ro }),
    f("pveVersion", "Proxmox VE Version", ro),
    f("kernel", "Kernel", ro),
    f("subscriptionLevel", "Subscription", ro),
    f("subscriptionStatus", "Subscription Status", ro),
    f("subscriptionDue", "Subscription Due", ro),
  ],
  outputs: [o("ip", "IP Address"), o("nodeName", "Node Name")],
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "server",
  sshEndpoint: {
    hostOutputKey: "ip",
    runningWhen: { fieldKey: "status", value: "online" },
    defaultUsername: "root",
  },
  expiryFields: [
    {
      fieldKey: "subscriptionDue",
      from: "expiry",
      kind: "other",
      label: "Proxmox VE subscription due",
    },
  ],
});

const guestCommon = {
  vmid: f("vmid", "VMID", { kind: "number", ...ro }),
  node: f("node", "Node", { ...ro, description: "Cluster node the guest currently runs on" }),
  template: f("template", "Template", { kind: "boolean", ...ro }),
  onboot: f("onboot", "Start at Boot", {
    kind: "boolean",
    required: false,
    description: "Start the guest when its node boots",
  }),
  protection: f("protection", "Protection", {
    kind: "boolean",
    required: false,
    description: "When on, Proxmox refuses to remove the guest or its disks",
  }),
  tags: f("tags", "Tags", {
    required: false,
    description: "Semicolon-separated tags, e.g. prod;web",
  }),
  description: f("description", "Notes", { required: false }),
  pool: f("pool", "Pool", { ...ro, description: "Resource pool the guest belongs to" }),
  haState: f("haState", "HA State", ro),
  lock: f("lock", "Lock", ro),
  networks: f("networks", "Network Devices", ro),
};

export const VmResourceType = rt({
  name: "Virtual Machine",
  id: VM,
  description: "A QEMU/KVM virtual machine (or VM template)",
  fields: [
    f("name", "Name"),
    guestCommon.vmid,
    guestCommon.node,
    f("status", "Status", {
      kind: "enum",
      enumValues: ["running", "stopped", "paused", "unknown"],
      ...ro,
    }),
    guestCommon.template,
    f("cores", "Cores per Socket", { kind: "number", required: false }),
    f("sockets", "Sockets", { kind: "number", required: false }),
    f("memoryMb", "Memory (MiB)", {
      kind: "number",
      required: false,
      description:
        "Memory changes on a running VM apply after a reboot unless memory hotplug is on",
    }),
    f("balloonMb", "Minimum Memory (MiB)", {
      kind: "number",
      required: false,
      description: "Ballooning target; 0 disables the balloon device",
    }),
    f("cpuType", "CPU Type", { required: false, description: "e.g. host, x86-64-v2-AES, kvm64" }),
    f("ostype", "Guest OS Type", {
      kind: "enum",
      required: false,
      enumValues: [
        "l26",
        "l24",
        "win11",
        "win10",
        "win8",
        "win7",
        "wvista",
        "w2k8",
        "w2k3",
        "w2k",
        "wxp",
        "solaris",
        "other",
      ],
    }),
    f("diskGb", "Boot Disk (GiB)", { kind: "number", ...ro }),
    f("disks", "Disks", ro),
    guestCommon.networks,
    f("agent", "QEMU Guest Agent", {
      kind: "boolean",
      required: false,
      description: "Enable the guest agent device (the agent must also run inside the VM)",
    }),
    guestCommon.onboot,
    guestCommon.protection,
    guestCommon.tags,
    guestCommon.description,
    guestCommon.pool,
    guestCommon.haState,
    guestCommon.lock,
  ],
  outputs: [
    o("ipv4", "IPv4 Address", { description: "Reported by the QEMU guest agent" }),
    o("ipv6", "IPv6 Address", { description: "Reported by the QEMU guest agent" }),
    o("vmid", "VMID"),
    o("node", "Node"),
  ],
  dependsOn: [
    { fieldKey: "node", targetTypeId: NODE, label: "runs on" },
    { fieldKey: "pool", targetTypeId: POOL, label: "in pool" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "server",
  lifecycle: {
    startActionId: "start",
    stopActionId: "shutdown",
    statusFieldKey: "status",
    runningValues: ["running"],
    stoppedValues: ["stopped"],
  },
  sshEndpoint: {
    hostOutputKey: "ipv4",
    runningWhen: { fieldKey: "status", value: "running" },
    defaultUsername: "root",
  },
  backupPolicy: { protectedBy: [BACKUP] },
});

export const CtResourceType = rt({
  name: "Container",
  id: CT,
  description: "An LXC container (or container template)",
  fields: [
    f("name", "Hostname"),
    guestCommon.vmid,
    guestCommon.node,
    f("status", "Status", { kind: "enum", enumValues: ["running", "stopped", "unknown"], ...ro }),
    guestCommon.template,
    f("cores", "Cores", {
      kind: "number",
      required: false,
      description: "Empty means the container may use every core of its node",
    }),
    f("memoryMb", "Memory (MiB)", { kind: "number", required: false }),
    f("swapMb", "Swap (MiB)", { kind: "number", required: false }),
    f("diskGb", "Root Disk (GiB)", { kind: "number", ...ro }),
    f("rootfs", "Root Filesystem", ro),
    f("ostype", "Distribution", ro),
    f("unprivileged", "Unprivileged", { kind: "boolean", ...ro }),
    f("features", "Features", {
      required: false,
      description: "e.g. nesting=1,keyctl=1 (changing it may need root@pam)",
    }),
    guestCommon.networks,
    guestCommon.onboot,
    guestCommon.protection,
    guestCommon.tags,
    guestCommon.description,
    guestCommon.pool,
    guestCommon.haState,
    guestCommon.lock,
  ],
  outputs: [
    o("ipv4", "IPv4 Address"),
    o("ipv6", "IPv6 Address"),
    o("vmid", "VMID"),
    o("node", "Node"),
  ],
  dependsOn: [
    { fieldKey: "node", targetTypeId: NODE, label: "runs on" },
    { fieldKey: "pool", targetTypeId: POOL, label: "in pool" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "container",
  lifecycle: {
    startActionId: "start",
    stopActionId: "shutdown",
    statusFieldKey: "status",
    runningValues: ["running"],
    stoppedValues: ["stopped"],
  },
  sshEndpoint: {
    hostOutputKey: "ipv4",
    runningWhen: { fieldKey: "status", value: "running" },
    defaultUsername: "root",
  },
  backupPolicy: { protectedBy: [BACKUP] },
});

export const StorageResourceType = rt({
  name: "Storage",
  plural: "Storage",
  id: STORAGE,
  description: "A storage as seen from one node: disk images, ISOs, container templates, backups",
  fields: [
    f("storage", "Storage ID", ro),
    f("node", "Node", ro),
    f("type", "Type", ro),
    f("content", "Content Types", {
      required: false,
      description: "Comma-separated: images, rootdir, iso, vztmpl, backup, snippets, import",
    }),
    f("shared", "Shared", { kind: "boolean", ...ro }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("totalGb", "Capacity (GiB)", { kind: "number", ...ro }),
  ],
  outputs: [o("storage", "Storage ID")],
  dependsOn: [{ fieldKey: "node", targetTypeId: NODE, label: "on" }],
  supportsUpdate: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "volume",
});

export const BackupResourceType = rt({
  name: "Backup",
  id: BACKUP,
  description: "A vzdump backup archive of a VM or container",
  pinnable: false,
  parentTypeId: STORAGE,
  showInSidebar: true,
  fields: [
    f("volid", "Volume ID", ro),
    f("storage", "Storage", ro),
    f("node", "Node", ro),
    f("vmid", "Guest VMID", ro),
    f("guestType", "Guest Type", { kind: "enum", enumValues: ["qemu", "lxc"], ...ro }),
    f("vmId", "Virtual Machine", ro),
    f("ctId", "Container", ro),
    f("createdAt", "Created", ro),
    f("sizeGb", "Size (GiB)", { kind: "number", ...ro }),
    f("format", "Format", ro),
    f("encrypted", "Encrypted", { kind: "boolean", ...ro }),
    f("verifyState", "Verification", ro),
    f("notes", "Notes", { required: false }),
    f("protected", "Protected", {
      kind: "boolean",
      required: false,
      description: "Protected backups are never pruned or deleted",
    }),
  ],
  outputs: [o("volid", "Volume ID")],
  dependsOn: [
    { fieldKey: "vmId", targetTypeId: VM, label: "backup of" },
    { fieldKey: "ctId", targetTypeId: CT, label: "backup of" },
  ],
  supportsUpdate: true,
  iconKey: "backup",
  backupRole: { role: "snapshot", sourceKey: "vmid", createdKey: "createdAt", sizeKey: "sizeGb" },
});

export const BackupJobResourceType = rt({
  name: "Backup Job",
  id: BACKUP_JOB,
  description: "A scheduled vzdump backup job",
  fields: [
    f("jobId", "Job ID", ro),
    f("schedule", "Schedule", { description: "systemd calendar event, e.g. 'daily', 'sat 02:00'" }),
    f("storage", "Storage", { required: false }),
    f("selection", "Guests", {
      required: false,
      description: "Comma-separated VMIDs. Leave empty with All Guests on, or set a pool",
    }),
    f("all", "All Guests", { kind: "boolean", required: false }),
    f("exclude", "Excluded Guests", {
      required: false,
      description: "VMIDs skipped when All Guests is on",
    }),
    f("pool", "Pool", { required: false }),
    f("node", "Only on Node", { required: false }),
    f("mode", "Mode", {
      kind: "enum",
      enumValues: ["snapshot", "suspend", "stop"],
      required: false,
    }),
    f("compress", "Compression", {
      kind: "enum",
      enumValues: ["zstd", "lzo", "gzip", "0"],
      required: false,
    }),
    f("enabled", "Enabled", { kind: "boolean", required: false }),
    f("comment", "Comment", { required: false }),
    f("notesTemplate", "Notes Template", { required: false, description: "e.g. {{guestname}}" }),
    f("pruneBackups", "Retention", {
      required: false,
      description: "e.g. keep-daily=7,keep-weekly=4. Empty uses the storage's retention",
    }),
    f("repeatMissed", "Repeat Missed", { kind: "boolean", required: false }),
    f("nextRun", "Next Run", ro),
  ],
  outputs: [o("jobId", "Job ID")],
  dependsOn: [{ fieldKey: "pool", targetTypeId: POOL, label: "backs up" }],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "backup",
});

export const PoolResourceType = rt({
  name: "Pool",
  id: POOL,
  description: "A resource pool grouping guests and storage for permissions and backups",
  fields: [
    f("poolid", "Pool ID", ro),
    f("comment", "Comment", { required: false }),
    f("members", "Members", ro),
    f("memberCount", "Member Count", { kind: "number", ...ro }),
  ],
  outputs: [o("poolid", "Pool ID")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "folder",
  orphanRule: {
    conditions: [{ fieldKey: "memberCount", when: "equals", value: "0" }],
    reason: "Pool has no guests or storage in it",
  },
});

export const HaResourceResourceType = rt({
  name: "HA Resource",
  id: HA_RESOURCE,
  description: "A guest managed by the Proxmox VE high-availability stack",
  fields: [
    f("sid", "Service ID", ro),
    f("guestType", "Guest Type", { kind: "enum", enumValues: ["vm", "ct"], ...ro }),
    f("vmid", "VMID", ro),
    f("vmId", "Virtual Machine", ro),
    f("ctId", "Container", ro),
    f("state", "Requested State", {
      kind: "enum",
      enumValues: ["started", "stopped", "disabled", "ignored"],
      required: false,
    }),
    f("maxRestart", "Max Restarts", { kind: "number", required: false }),
    f("maxRelocate", "Max Relocations", { kind: "number", required: false }),
    f("failback", "Failback", {
      kind: "boolean",
      required: false,
      description:
        "Move back to the highest-priority node of its node affinity rule when it returns",
    }),
    f("group", "HA Group", ro),
    f("comment", "Comment", { required: false }),
    f("node", "Current Node", ro),
    f("currentState", "Current State", ro),
  ],
  outputs: [o("sid", "Service ID")],
  dependsOn: [
    { fieldKey: "vmId", targetTypeId: VM, label: "protects" },
    { fieldKey: "ctId", targetTypeId: CT, label: "protects" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "shield",
});

export const HaRuleResourceType = rt({
  name: "HA Rule",
  id: HA_RULE,
  description:
    "A high-availability placement rule (Proxmox VE 9+): node affinity or resource affinity",
  fields: [
    f("rule", "Rule ID", ro),
    f("type", "Type", { kind: "enum", enumValues: ["node-affinity", "resource-affinity"], ...ro }),
    f("resources", "Resources", { description: "e.g. vm:100,ct:101" }),
    f("nodes", "Nodes", {
      required: false,
      description: "Node affinity only: node[:priority], comma-separated, e.g. pve1:2,pve2:1",
    }),
    f("affinity", "Affinity", {
      kind: "enum",
      enumValues: ["positive", "negative"],
      required: false,
    }),
    f("strict", "Strict", { kind: "boolean", required: false }),
    f("disable", "Disabled", { kind: "boolean", required: false }),
    f("comment", "Comment", { required: false }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "shield",
});

const fwRuleFields = [
  f("pos", "Position", { kind: "number", ...ro }),
  f("type", "Direction", { kind: "enum", enumValues: ["in", "out", "forward", "group"] }),
  f("action", "Action", {
    description: "ACCEPT, DROP, REJECT, or a security group name for a group rule",
  }),
  f("enable", "Enabled", { kind: "boolean", required: false }),
  f("macro", "Macro", { required: false, description: "Predefined service, e.g. SSH, HTTPS" }),
  f("proto", "Protocol", { required: false }),
  f("source", "Source", {
    required: false,
    description: "IP, CIDR, +ipset or alias. Empty is any",
  }),
  f("dest", "Destination", { required: false }),
  f("sport", "Source Port", { required: false }),
  f("dport", "Destination Port", { required: false }),
  f("iface", "Interface", { required: false }),
  f("log", "Log Level", {
    kind: "enum",
    required: false,
    enumValues: ["nolog", "emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"],
  }),
  f("comment", "Comment", { required: false }),
];

export const FirewallRuleResourceType = rt({
  name: "Firewall Rule",
  id: FW_RULE,
  description: "A datacenter-level firewall rule",
  fields: fwRuleFields,
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "firewall",
  postureChecks: [
    {
      id: "pve-firewall-accept-any-source",
      title: "Inbound rule accepts any source",
      severity: "medium",
      category: "public-exposure",
      conditions: [
        { fieldKey: "type", when: "equals", value: "in" },
        { fieldKey: "action", when: "equals", value: "ACCEPT" },
        { fieldKey: "enable", when: "truthy" },
        { fieldKey: "source", when: "empty" },
      ],
      reason:
        "An enabled inbound ACCEPT rule with no source restriction admits matching traffic from any address.",
    },
  ],
});

export const SecurityGroupResourceType = rt({
  name: "Security Group",
  id: SECURITY_GROUP,
  description: "A named set of firewall rules that cluster, node and guest firewalls can include",
  fields: [
    f("group", "Name", ro),
    f("comment", "Comment", { required: false }),
    f("ruleCount", "Rules", { kind: "number", ...ro }),
  ],
  outputs: [o("group", "Name")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "firewall",
});

export const FirewallAliasResourceType = rt({
  name: "Firewall Alias",
  plural: "Firewall Aliases",
  id: FW_ALIAS,
  description: "A named IP address or network usable in firewall rules",
  fields: [
    f("name", "Name", ro),
    f("cidr", "Address / CIDR"),
    f("comment", "Comment", { required: false }),
  ],
  outputs: [o("cidr", "Address / CIDR")],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "firewall",
});

export const IpsetResourceType = rt({
  name: "IP Set",
  id: IPSET,
  description: "A named list of addresses and networks usable in firewall rules as +name",
  fields: [
    f("name", "Name", ro),
    f("comment", "Comment", { required: false }),
    f("entries", "Entries", ro),
    f("entryCount", "Entry Count", { kind: "number", ...ro }),
  ],
  outputs: [],
  supportsCreate: true,
  supportsUpdate: true,
  pinnable: false,
  iconKey: "firewall",
});

export const resourceTypes: ResourceTypeDefinition[] = [
  ClusterResourceType,
  NodeResourceType,
  VmResourceType,
  CtResourceType,
  StorageResourceType,
  BackupResourceType,
  BackupJobResourceType,
  PoolResourceType,
  HaResourceResourceType,
  HaRuleResourceType,
  FirewallRuleResourceType,
  SecurityGroupResourceType,
  FirewallAliasResourceType,
  IpsetResourceType,
];
