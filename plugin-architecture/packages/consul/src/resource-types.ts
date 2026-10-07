import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

const ro = { required: false, editable: false } as const;
const num = (key: string, label: string) => f(key, label, { ...ro, kind: "number" });
const bool = (key: string, label: string) => f(key, label, { ...ro, kind: "boolean" });

/** Config entry kinds listed and offered for creation (Consul 1.22 / 2.0). */
export const CONFIG_KINDS = [
  "service-defaults",
  "proxy-defaults",
  "service-router",
  "service-splitter",
  "service-resolver",
  "service-intentions",
  "ingress-gateway",
  "terminating-gateway",
  "api-gateway",
  "http-route",
  "tcp-route",
  "mesh",
  "exported-services",
  "sameness-group",
  "jwt-provider",
  "control-plane-request-limit",
];

export const ClusterResourceType = rt({
  name: "Cluster",
  id: "consul-cluster",
  accountRoot: true,
  description:
    "The Consul datacenter this agent belongs to: version, leader and Raft servers, autopilot health and failure tolerance, datacenters, members and catalog totals. The Keys tab browses and edits the KV store. The Metrics tab records Raft and runtime gauges.",
  fields: [
    f("address", "Address", ro),
    f("version", "Version", ro),
    f("datacenter", "Datacenter", ro),
    f("agentNode", "Agent Node", ro),
    bool("agentIsServer", "Agent Is a Server"),
    f("leader", "Leader", ro),
    num("raftServers", "Raft Servers"),
    num("voters", "Voters"),
    bool("healthy", "Autopilot Healthy"),
    num("failureTolerance", "Failure Tolerance"),
    f("datacenters", "Datacenters", ro),
    num("members", "LAN Members"),
    num("nodes", "Catalog Nodes"),
    num("services", "Services"),
    num("criticalChecks", "Critical Checks"),
    num("warningChecks", "Warning Checks"),
  ],
  outputs: [o("address", "Consul HTTP address"), o("datacenter", "Datacenter")],
  secretExportTemplates: [
    {
      id: "consul-addr",
      displayName: "Consul address",
      entries: [
        { envKey: "CONSUL_HTTP_ADDR", outputKey: "address" },
        { envKey: "CONSUL_DATACENTER", outputKey: "datacenter" },
      ],
    },
  ],
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "server",
});

export const NodeResourceType = rt({
  name: "Node",
  id: "consul-node",
  description:
    "A node in the catalog: address, datacenter, metadata, its services and its health checks. Deregister a node that is gone (a live agent registers itself again).",
  fields: [
    f("name", "Name", ro),
    f("address", "Address", ro),
    f("datacenter", "Datacenter", ro),
    f("partition", "Partition", ro),
    f("meta", "Metadata", ro),
    num("services", "Services"),
    num("passing", "Passing Checks"),
    num("warning", "Warning Checks"),
    num("critical", "Critical Checks"),
  ],
  outputs: [o("address", "Address")],
  supportsDelete: true,
  iconKey: "server",
});

export const ServiceResourceType = rt({
  name: "Service",
  id: "consul-service",
  description:
    "A service in the catalog with its tags, instances and their health. The instance table shows each node, address, port and check status.",
  fields: [
    f("name", "Name", ro),
    f("namespace", "Namespace", ro),
    f("tags", "Tags", ro),
    num("instances", "Instances"),
    num("passing", "Passing Checks"),
    num("warning", "Warning Checks"),
    num("critical", "Critical Checks"),
    f("kind", "Kind", ro),
  ],
  outputs: [o("name", "Service name"), o("dnsName", "DNS name")],
  iconKey: "globe",
});

export const CheckResourceType = rt({
  name: "Health Check",
  id: "consul-check",
  description: "A health check on a node or service instance: status, type, output and notes.",
  fields: [
    f("name", "Name", ro),
    f("checkId", "Check ID", ro),
    f("status", "Status", ro),
    f("node", "Node", ro),
    f("serviceName", "Service", ro),
    f("serviceId", "Service Instance", ro),
    f("type", "Type", ro),
    f("output", "Output", ro),
    f("notes", "Notes", ro),
  ],
  dependsOn: [
    { fieldKey: "node", targetTypeId: "consul-node", targetKey: "name", label: "on" },
    { fieldKey: "serviceName", targetTypeId: "consul-service", targetKey: "name", label: "for" },
  ],
  pinnable: false,
  iconKey: "activity",
});

export const IntentionResourceType = rt({
  name: "Intention",
  id: "consul-intention",
  description:
    "A service mesh intention: whether a source service may connect to a destination, as an L4 allow or deny or as L7 permissions. Create, change the action and description, or delete it.",
  fields: [
    f("source", "Source", ro),
    f("destination", "Destination", ro),
    f("action", "Action", {
      kind: "enum",
      enumValues: ["allow", "deny"],
      required: false,
      description: "L4 intentions only; L7 intentions use permissions.",
    }),
    f("description", "Description", { required: false }),
    f("permissions", "L7 Permissions", ro),
    f("sourceType", "Source Type", ro),
    num("precedence", "Precedence"),
  ],
  dependsOn: [
    { fieldKey: "source", targetTypeId: "consul-service", targetKey: "name", label: "from" },
    { fieldKey: "destination", targetTypeId: "consul-service", targetKey: "name", label: "to" },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "shield",
});

export const ConfigEntryResourceType = rt({
  name: "Config Entry",
  plural: "Config Entries",
  id: "consul-config-entry",
  description:
    "A centralised configuration entry: service defaults, proxy defaults, routers, splitters, resolvers, intentions, gateways and routes, mesh, exported services and more. Edit it as JSON, create one from a starter document, or delete it.",
  fields: [
    f("kind", "Kind", ro),
    f("name", "Name", ro),
    f("namespace", "Namespace", ro),
    f("partition", "Partition", ro),
    f("summary", "Summary", ro),
    num("modifyIndex", "Modify Index"),
  ],
  dependsOn: [
    { fieldKey: "name", targetTypeId: "consul-service", targetKey: "name", label: "configures" },
  ],
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "settings",
});

export const AclPolicyResourceType = rt({
  name: "ACL Policy",
  plural: "ACL Policies",
  id: "consul-acl-policy",
  description:
    "An ACL policy: HCL rules, description and the datacenters it applies in. Create, edit its rules and description, or delete it.",
  fields: [
    f("name", "Name", { required: false }),
    f("description", "Description", { required: false }),
    f("datacenters", "Datacenters", {
      required: false,
      description: "Comma-separated; empty means all.",
    }),
    bool("builtIn", "Built In"),
  ],
  outputs: [o("id", "Policy ID"), o("rules", "Rules (HCL)", { hidden: true })],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "shield",
});

export const AclRoleResourceType = rt({
  name: "ACL Role",
  id: "consul-acl-role",
  description:
    "An ACL role: a named set of policies and service or node identities that tokens can carry. Create, edit or delete it.",
  fields: [
    f("name", "Name", { required: false }),
    f("description", "Description", { required: false }),
    f("policies", "Policies", { required: false, description: "Comma-separated policy names." }),
    f("serviceIdentities", "Service Identities", {
      required: false,
      description: "Comma-separated service names.",
    }),
    f("nodeIdentities", "Node Identities", ro),
  ],
  outputs: [o("id", "Role ID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "users",
});

export const AclTokenResourceType = rt({
  name: "ACL Token",
  id: "consul-acl-token",
  description:
    "An ACL token by accessor: description, policies, roles, service and node identities, whether it is local, and when it expires. Create, edit or delete it.",
  fields: [
    f("accessorId", "Accessor ID", ro),
    f("description", "Description", { required: false }),
    f("policies", "Policies", { required: false, description: "Comma-separated policy names." }),
    f("roles", "Roles", { required: false, description: "Comma-separated role names." }),
    f("serviceIdentities", "Service Identities", {
      required: false,
      description: "Comma-separated service names.",
    }),
    f("nodeIdentities", "Node Identities", ro),
    bool("local", "Local"),
    f("authMethod", "Auth Method", ro),
    f("createTime", "Created", ro),
    f("expirationTime", "Expires", ro),
    bool("management", "Global Management"),
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
      id: "consul-management-token",
      title: "Token carries global-management",
      severity: "medium",
      category: "credential-age",
      conditions: [{ fieldKey: "management", when: "equals", value: "true" }],
      reason:
        "global-management bypasses every ACL rule. Keep such tokens few, and prefer scoped policies.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "key",
});

export const SessionResourceType = rt({
  name: "Session",
  id: "consul-session",
  description:
    "A session: the node and checks it is tied to, its TTL and behaviour, and the locks it holds. Renew or destroy it.",
  fields: [
    f("id", "ID", ro),
    f("name", "Name", ro),
    f("node", "Node", ro),
    f("behavior", "Behavior", ro),
    f("ttl", "TTL", ro),
    f("lockDelay", "Lock Delay", ro),
    f("checks", "Checks", ro),
  ],
  dependsOn: [{ fieldKey: "node", targetTypeId: "consul-node", targetKey: "name", label: "on" }],
  supportsDelete: true,
  pinnable: false,
  iconKey: "lock",
});

export const PeeringResourceType = rt({
  name: "Peering",
  id: "consul-peering",
  description:
    "A cluster peering connection: state, the peer's server name and addresses, and how many services are imported and exported. Generate a peering token for another cluster, establish a peering from one, or delete it.",
  fields: [
    f("name", "Name", ro),
    f("state", "State", ro),
    f("peerServerName", "Peer Server Name", ro),
    f("peerServerAddresses", "Peer Server Addresses", ro),
    num("importedServices", "Imported Services"),
    num("exportedServices", "Exported Services"),
    f("partition", "Partition", ro),
  ],
  outputs: [o("peeringToken", "Peering token", { sensitive: true, hidden: true })],
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "link",
});

export const NamespaceResourceType = rt({
  name: "Namespace",
  id: "consul-namespace",
  description:
    "A Consul Enterprise namespace. Create, edit its description and metadata, or delete it.",
  fields: [
    f("name", "Name", ro),
    f("description", "Description", { required: false }),
    f("partition", "Partition", ro),
    f("meta", "Metadata", { required: false, description: "Comma-separated key=value pairs." }),
  ],
  outputs: [o("name", "Namespace name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "folder",
});

export const PartitionResourceType = rt({
  name: "Admin Partition",
  id: "consul-partition",
  description: "A Consul Enterprise admin partition. Create, edit its description, or delete it.",
  fields: [f("name", "Name", ro), f("description", "Description", { required: false })],
  outputs: [o("name", "Partition name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "layers",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ClusterResourceType,
  NodeResourceType,
  ServiceResourceType,
  CheckResourceType,
  IntentionResourceType,
  ConfigEntryResourceType,
  AclPolicyResourceType,
  AclRoleResourceType,
  AclTokenResourceType,
  SessionResourceType,
  PeeringResourceType,
  NamespaceResourceType,
  PartitionResourceType,
];
