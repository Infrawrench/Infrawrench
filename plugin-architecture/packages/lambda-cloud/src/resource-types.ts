import { f, o, rt } from "@infrawrench/plugin-base";
import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";

/**
 * externalIds are Lambda's own ids. The global firewall ruleset's id is the
 * literal `global`, which is also its API path. `region` holds Lambda region
 * codes (`us-east-1`, `us-south-2`), which status incidents name in titles.
 */

export const INSTANCE_STATES = [
  "booting",
  "active",
  "unhealthy",
  "terminating",
  "terminated",
  "preempted",
] as const;

const RULES_DESCRIPTION =
  "One rule per line: protocol ports source description, e.g. `tcp 22 0.0.0.0/0 SSH` or `icmp - 0.0.0.0/0 ping`. Ports is a port, a min-max range, or - for all";

export const InstanceResourceType = rt({
  name: "Instance",
  id: "instance",
  description: "A Lambda Cloud on-demand GPU instance",
  fields: [
    f("name", "Name", { required: false }),
    f("status", "Status", { kind: "enum", enumValues: [...INSTANCE_STATES], editable: false }),
    f("region", "Region", { editable: false }),
    f("regionName", "Region Name", { required: false, editable: false }),
    f("instanceType", "Instance Type", { editable: false }),
    f("gpuDescription", "GPU", { required: false, editable: false }),
    f("gpus", "GPUs", { kind: "number", required: false, editable: false }),
    f("vcpus", "vCPUs", { kind: "number", required: false, editable: false }),
    f("memoryGib", "Memory (GiB)", { kind: "number", required: false, editable: false }),
    f("storageGib", "Local Storage (GiB)", { kind: "number", required: false, editable: false }),
    f("architecture", "Architecture", { required: false, editable: false }),
    f("pricePerHour", "Price ($/hr)", { kind: "number", required: false, editable: false }),
    f("imageFamily", "Image", { required: false, editable: false }),
    f("sshKeyNames", "SSH Keys", { required: false, editable: false }),
    f("filesystemIds", "Filesystems", { required: false, editable: false }),
    f("firewallRulesetIds", "Firewall Rulesets", { required: false, editable: false }),
    f("tags", "Tags", {
      required: false,
      description: "Comma-separated key=value pairs. Keys starting with lambda-ai- are reserved",
    }),
    f("hostname", "Hostname", { required: false, editable: false }),
    f("firstHealthy", "First Healthy", { required: false, editable: false }),
    f("restartBlocked", "Restart Unavailable Because", { required: false, editable: false }),
  ],
  outputs: [
    o("ip", "Public IPv4"),
    o("privateIp", "Private IPv4"),
    o("sshCommand", "SSH Command"),
    o("jupyterUrl", "JupyterLab URL", {
      sensitive: true,
      hidden: true,
      description: "Opens JupyterLab on the instance; the link carries its login token",
    }),
    o("jupyterToken", "JupyterLab Token", { sensitive: true, hidden: true }),
  ],
  dependsOn: [
    { fieldKey: "filesystemIds", targetTypeId: "filesystem", label: "mounts" },
    { fieldKey: "firewallRulesetIds", targetTypeId: "firewall-ruleset", label: "protected by" },
  ],
  showInSidebar: true,
  iconKey: "server",
  supportsCreate: true,
  // Edit = rename and retag (the only fields Lambda's update accepts).
  supportsUpdate: true,
  sshEndpoint: {
    hostOutputKey: "ip",
    privateHostOutputKey: "privateIp",
    runningWhen: { fieldKey: "status", value: "active" },
    // Lambda Stack images log in as ubuntu.
    defaultUsername: "ubuntu",
  },
});

export const FilesystemResourceType = rt({
  name: "Filesystem",
  id: "filesystem",
  description: "A persistent Lambda Cloud filesystem in one region",
  fields: [
    f("name", "Name", { editable: false }),
    f("region", "Region", { editable: false }),
    f("mountPoint", "Default Mount Point", { required: false, editable: false }),
    f("inUse", "In Use", { kind: "boolean", required: false, editable: false }),
    f("usedGb", "Used (GB)", {
      kind: "number",
      required: false,
      editable: false,
      description: "Approximate; Lambda refreshes it every few hours",
    }),
    f("createdBy", "Created By", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  showInSidebar: true,
  iconKey: "volume",
  supportsCreate: true,
  orphanRule: {
    conditions: [{ fieldKey: "inUse", when: "equals", value: "false" }],
    reason:
      "No instance mounts this filesystem, but Lambda bills its stored data every month until it is deleted.",
  },
});

export const FirewallRulesetResourceType = rt({
  name: "Firewall Ruleset",
  id: "firewall-ruleset",
  description: "Inbound firewall rules for the instances in one region that use this ruleset",
  fields: [
    f("name", "Name"),
    f("region", "Region", { editable: false }),
    f("rules", "Rules", { description: RULES_DESCRIPTION }),
    f("ruleCount", "Rule Count", { kind: "number", required: false, editable: false }),
    f("instanceIds", "Instances", { required: false, editable: false }),
    f("openToInternet", "Open to the Internet", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("sshOpenToInternet", "SSH Open to the Internet", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  dependsOn: [{ fieldKey: "instanceIds", targetTypeId: "instance", label: "protects" }],
  showInSidebar: true,
  iconKey: "firewall",
  supportsCreate: true,
  supportsUpdate: true,
  postureChecks: [
    {
      id: "lambda-ssh-open-to-internet",
      title: "SSH open to the internet",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "sshOpenToInternet", when: "truthy" }],
      reason: "A rule allows TCP port 22 from 0.0.0.0/0, so any address can attempt to log in.",
    },
  ],
});

export const GlobalFirewallResourceType = rt({
  name: "Global Firewall Rules",
  plural: "Global Firewall Rules",
  id: "global-firewall",
  description: "Inbound firewall rules Lambda applies to every instance in every region",
  fields: [
    f("name", "Name", { editable: false }),
    f("rules", "Rules", { description: RULES_DESCRIPTION }),
    f("ruleCount", "Rule Count", { kind: "number", required: false, editable: false }),
    f("openToInternet", "Open to the Internet", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("sshOpenToInternet", "SSH Open to the Internet", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
  ],
  iconKey: "firewall",
  supportsUpdate: true,
  supportsDelete: false,
  postureChecks: [
    {
      id: "lambda-global-ssh-open-to-internet",
      title: "SSH open to the internet on every instance",
      severity: "medium",
      category: "public-exposure",
      conditions: [{ fieldKey: "sshOpenToInternet", when: "truthy" }],
      reason:
        "The global ruleset allows TCP port 22 from 0.0.0.0/0, which applies to every instance on the account.",
    },
  ],
});

export const SshKeyResourceType = rt({
  name: "SSH Key",
  id: "ssh-key",
  description: "An SSH public key that can be installed on new instances",
  fields: [f("name", "Name"), f("publicKey", "Public Key", { required: false })],
  iconKey: "key",
  supportsCreate: true,
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  InstanceResourceType,
  FilesystemResourceType,
  FirewallRulesetResourceType,
  GlobalFirewallResourceType,
  SshKeyResourceType,
];
