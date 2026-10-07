import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

const ro = { required: false, editable: false } as const;
const num = (key: string, label: string) => f(key, label, { ...ro, kind: "number" });
const bool = (key: string, label: string) => f(key, label, { ...ro, kind: "boolean" });
const nsField = f("namespace", "Namespace", ro);
const inNamespace = {
  fieldKey: "namespace",
  targetTypeId: "nomad-namespace",
  targetKey: "name",
  label: "in",
} as const;

export const ClusterResourceType = rt({
  name: "Cluster",
  id: "nomad-cluster",
  accountRoot: true,
  description:
    "The Nomad cluster this address reaches: version, region and datacenter, leader and Raft peers, servers, regions, and how many nodes and jobs it runs. The Metrics tab charts scheduler and runtime gauges.",
  fields: [
    f("address", "Address", ro),
    f("version", "Version", ro),
    f("region", "Region", ro),
    f("datacenter", "Datacenter", ro),
    f("leader", "Leader", ro),
    num("raftPeers", "Raft Peers"),
    num("servers", "Servers"),
    f("regions", "Regions", ro),
    bool("aclEnabled", "ACLs Enabled"),
    num("nodes", "Nodes"),
    num("nodesReady", "Nodes Ready"),
    num("jobs", "Jobs"),
    num("jobsRunning", "Jobs Running"),
    num("jobsPending", "Jobs Pending"),
  ],
  outputs: [o("address", "Nomad address"), o("region", "Region")],
  secretExportTemplates: [
    {
      id: "nomad-addr",
      displayName: "Nomad address",
      entries: [
        { envKey: "NOMAD_ADDR", outputKey: "address" },
        { envKey: "NOMAD_REGION", outputKey: "region" },
      ],
    },
  ],
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "server",
});

export const NamespaceResourceType = rt({
  name: "Namespace",
  id: "nomad-namespace",
  description:
    "A namespace jobs, variables and volumes live in. Create, edit its description and metadata, or delete it once it is empty.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false }),
    f("quota", "Quota", { required: false, description: "Nomad Enterprise only." }),
    f("meta", "Metadata", { required: false, description: "Comma-separated key=value pairs." }),
  ],
  outputs: [o("name", "Namespace name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "folder",
});

export const NodePoolResourceType = rt({
  name: "Node Pool",
  id: "nomad-node-pool",
  description:
    "A node pool: a set of client nodes jobs can be placed on. Create, edit its description, scheduler algorithm and metadata, or delete it (all and default are built in).",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false }),
    f("schedulerAlgorithm", "Scheduler Algorithm", {
      kind: "enum",
      enumValues: ["", "binpack", "spread"],
      required: false,
      description: "Empty uses the cluster default.",
    }),
    f("meta", "Metadata", { required: false, description: "Comma-separated key=value pairs." }),
    num("nodes", "Nodes"),
  ],
  outputs: [o("name", "Node pool name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "layers",
});

export const NodeResourceType = rt({
  name: "Node",
  id: "nomad-node",
  description:
    "A client node: datacenter, class, pool, status, drain and scheduling eligibility, drivers and resources. Drain it, cancel a drain, mark it eligible or ineligible, or purge it once it is down. The Metrics tab shows its CPU, memory and disk use.",
  fields: [
    f("name", "Name", ro),
    f("datacenter", "Datacenter", ro),
    f("nodeClass", "Class", ro),
    f("nodePool", "Node Pool", ro),
    f("status", "Status", ro),
    bool("drain", "Draining"),
    f("eligibility", "Scheduling Eligibility", ro),
    f("address", "Address", ro),
    f("version", "Nomad Version", ro),
    f("drivers", "Healthy Drivers", ro),
    num("cpuMhz", "CPU (MHz)"),
    num("cores", "Cores"),
    num("memoryMb", "Memory (MB)"),
    num("diskMb", "Disk (MB)"),
    num("allocations", "Running Allocations"),
  ],
  outputs: [o("address", "Address"), o("name", "Node name")],
  dependsOn: [
    { fieldKey: "nodePool", targetTypeId: "nomad-node-pool", targetKey: "name", label: "in" },
  ],
  orphanRule: {
    conditions: [{ fieldKey: "status", when: "equals", value: "down" }],
    reason: "The node is down; purge it once it is not coming back.",
  },
  supportsMetrics: true,
  supportsDelete: true,
  iconKey: "server",
});

export const JobResourceType = rt({
  name: "Job",
  id: "nomad-job",
  description:
    "A service, batch, system or sysbatch job, periodic or parameterized: status, type, priority, version and task group counts. Run one from HCL, edit and resubmit its specification, stop, start, scale a group, dispatch, force a periodic run, revert to an earlier version, or stop and purge it.",
  fields: [
    nsField,
    f("id", "ID", ro),
    f("name", "Name", ro),
    f("type", "Type", ro),
    f("status", "Status", ro),
    f("statusDescription", "Status Description", ro),
    num("priority", "Priority"),
    f("datacenters", "Datacenters", ro),
    f("nodePool", "Node Pool", ro),
    num("version", "Version"),
    bool("stopped", "Stopped"),
    bool("periodic", "Periodic"),
    bool("parameterized", "Parameterized"),
    f("parentId", "Parent Job", ro),
    f("groups", "Task Groups", ro),
    num("running", "Running"),
    num("queued", "Queued"),
    num("failed", "Failed"),
    num("lost", "Lost"),
    f("submitTime", "Submitted", ro),
  ],
  outputs: [o("id", "Job ID"), o("namespace", "Namespace")],
  dependsOn: [
    inNamespace,
    { fieldKey: "nodePool", targetTypeId: "nomad-node-pool", targetKey: "name", label: "on" },
  ],
  supportsCreate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "box",
});

export const AllocationResourceType = rt({
  name: "Allocation",
  id: "nomad-allocation",
  parentTypeId: "nomad-job",
  showInSidebar: true,
  description:
    "A placement of a task group on a node: client and desired status, tasks and restarts, deployment health. Read task logs in the Logs tab, restart its tasks, or stop it so the scheduler replaces it. The Metrics tab shows its CPU and memory.",
  fields: [
    nsField,
    f("id", "ID", ro),
    f("name", "Name", ro),
    f("jobId", "Job", ro),
    num("jobVersion", "Job Version"),
    f("taskGroup", "Task Group", ro),
    f("node", "Node", ro),
    f("nodeId", "Node ID", ro),
    f("clientStatus", "Client Status", ro),
    f("desiredStatus", "Desired Status", ro),
    f("tasks", "Tasks", ro),
    num("restarts", "Restarts"),
    f("deploymentHealthy", "Deployment Health", ro),
    f("createTime", "Created", ro),
    f("modifyTime", "Modified", ro),
  ],
  dependsOn: [{ fieldKey: "nodeId", targetTypeId: "nomad-node", label: "on" }],
  supportsMetrics: true,
  pinnable: false,
  iconKey: "cpu",
});

export const DeploymentResourceType = rt({
  name: "Deployment",
  id: "nomad-deployment",
  parentTypeId: "nomad-job",
  showInSidebar: true,
  description:
    "A rolling or canary deployment of a job version: status and per-group placed, healthy and unhealthy counts. Promote canaries, pause or resume, or fail it (which rolls back when auto-revert is set).",
  fields: [
    nsField,
    f("id", "ID", ro),
    f("jobId", "Job", ro),
    num("jobVersion", "Job Version"),
    f("status", "Status", ro),
    f("statusDescription", "Status Description", ro),
    f("groups", "Task Groups", ro),
    num("desired", "Desired"),
    num("placed", "Placed"),
    num("healthy", "Healthy"),
    num("unhealthy", "Unhealthy"),
    num("canariesPending", "Canaries Awaiting Promotion"),
  ],
  pinnable: false,
  iconKey: "rocket",
});

export const VariableResourceType = rt({
  name: "Variable",
  id: "nomad-variable",
  description:
    "A Nomad variable: an encrypted set of key-value items at a path, readable by jobs through templates. The Items tab reveals and edits them; create or delete a variable.",
  fields: [
    nsField,
    f("path", "Path", ro),
    f("keys", "Item Keys", ro),
    num("items", "Items"),
    f("modifyTime", "Modified", ro),
  ],
  outputs: [
    o("path", "Variable path"),
    o("items", "Items (JSON)", { sensitive: true, hidden: true }),
  ],
  dependsOn: [inNamespace],
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "key",
});

export const AclPolicyResourceType = rt({
  name: "ACL Policy",
  plural: "ACL Policies",
  id: "nomad-acl-policy",
  description: "An ACL policy. Read and edit its HCL rules, create policies, or delete them.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false }),
  ],
  outputs: [o("name", "Policy name"), o("rules", "Rules (HCL)", { hidden: true })],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const AclTokenResourceType = rt({
  name: "ACL Token",
  id: "nomad-acl-token",
  description:
    "An ACL token by accessor: type, policies and roles, whether it is global and when it expires. Create one, change its name and policies, or revoke it. Listing tokens needs a management token.",
  fields: [
    f("accessorId", "Accessor ID", ro),
    f("name", "Name", { required: false }),
    f("type", "Type", ro),
    f("policies", "Policies", { required: false, description: "Comma-separated policy names." }),
    f("roles", "Roles", ro),
    bool("global", "Global"),
    f("createTime", "Created", ro),
    f("expirationTime", "Expires", ro),
  ],
  outputs: [
    o("accessorId", "Accessor ID"),
    o("secretId", "Secret ID", { sensitive: true, hidden: true }),
  ],
  expiryFields: [
    { fieldKey: "expirationTime", from: "expiry", kind: "api-token", label: "Token expires" },
  ],
  postureChecks: [
    {
      id: "nomad-management-token",
      title: "Management token",
      severity: "medium",
      category: "credential-age",
      conditions: [{ fieldKey: "type", when: "equals", value: "management" }],
      reason: "Management tokens bypass every ACL policy. Keep them few and short-lived.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "key",
});

export const VolumeResourceType = rt({
  name: "Volume",
  id: "nomad-volume",
  description:
    "A CSI volume or a dynamic host volume: plugin, provider, access and attachment modes, capacity, health and state. Deregister a CSI volume or delete a host volume.",
  fields: [
    nsField,
    f("id", "ID", ro),
    f("name", "Name", ro),
    f("type", "Type", ro),
    f("pluginId", "Plugin", ro),
    f("provider", "Provider", ro),
    f("state", "State", ro),
    bool("schedulable", "Schedulable"),
    f("accessMode", "Access Mode", ro),
    f("attachmentMode", "Attachment Mode", ro),
    num("capacityBytes", "Capacity (bytes)"),
    f("nodeId", "Node", ro),
    f("health", "Controllers / Nodes Healthy", ro),
  ],
  dependsOn: [
    inNamespace,
    { fieldKey: "pluginId", targetTypeId: "nomad-csi-plugin", label: "via" },
  ],
  supportsDelete: true,
  pinnable: false,
  iconKey: "hard-drive",
});

export const CsiPluginResourceType = rt({
  name: "CSI Plugin",
  id: "nomad-csi-plugin",
  description: "A CSI storage plugin and the health of its controller and node instances.",
  fields: [
    f("id", "ID", ro),
    f("provider", "Provider", ro),
    f("version", "Version", ro),
    bool("controllerRequired", "Controller Required"),
    f("controllers", "Controllers Healthy", ro),
    f("nodes", "Nodes Healthy", ro),
  ],
  pinnable: false,
  iconKey: "plug",
});

export const ServiceResourceType = rt({
  name: "Service",
  id: "nomad-service",
  description:
    "A service registered in Nomad's native service discovery, with its tags and every registered instance (address, port, allocation and node).",
  fields: [nsField, f("name", "Name", ro), f("tags", "Tags", ro), num("instances", "Instances")],
  dependsOn: [inNamespace],
  pinnable: false,
  iconKey: "globe",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ClusterResourceType,
  NamespaceResourceType,
  NodePoolResourceType,
  NodeResourceType,
  JobResourceType,
  AllocationResourceType,
  DeploymentResourceType,
  VariableResourceType,
  AclPolicyResourceType,
  AclTokenResourceType,
  VolumeResourceType,
  CsiPluginResourceType,
  ServiceResourceType,
];
