import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/** RabbitMQ resource types, everything the management API user can see. */
const ro = { required: false, editable: false } as const;
const num = (key: string, label: string) => f(key, label, { ...ro, kind: "number" });
const bool = (key: string, label: string) => f(key, label, { ...ro, kind: "boolean" });
const vhostField = f("vhost", "Virtual Host", ro);
const inVhost = {
  fieldKey: "vhost",
  targetTypeId: "rabbitmq-vhost",
  targetKey: "name",
  label: "in",
} as const;
const forUser = (label: string) =>
  ({ fieldKey: "user", targetTypeId: "rabbitmq-user", targetKey: "name", label }) as const;

export const QUEUE_TYPES = ["classic", "quorum", "stream"];
export const EXCHANGE_TYPES = ["direct", "fanout", "topic", "headers"];
export const USER_TAGS = [
  "administrator",
  "monitoring",
  "policymaker",
  "management",
  "impersonator",
];
export const POLICY_APPLY_TO = [
  "all",
  "exchanges",
  "queues",
  "classic_queues",
  "quorum_queues",
  "streams",
];
export const OPERATOR_POLICY_APPLY_TO = ["queues", "classic_queues", "quorum_queues", "streams"];

export const ClusterResourceType = rt({
  name: "Cluster",
  id: "rabbitmq-cluster",
  accountRoot: true,
  description:
    "The RabbitMQ cluster behind this management endpoint: versions, object totals, queued messages, message rates and alarms. Rename it, export or import definitions, and rebalance queue leaders. The Metrics tab charts message rates and queue depth.",
  fields: [
    f("clusterName", "Cluster Name", {
      required: false,
      description: "Shown in the management UI and reported to clients in server properties.",
    }),
    f("rabbitmqVersion", "RabbitMQ Version", ro),
    f("erlangVersion", "Erlang/OTP", ro),
    f("managementVersion", "Management Plugin", ro),
    f("node", "Answering Node", ro),
    num("nodes", "Nodes"),
    num("connections", "Connections"),
    num("channels", "Channels"),
    num("exchanges", "Exchanges"),
    num("queues", "Queues"),
    num("consumers", "Consumers"),
    num("messages", "Messages"),
    num("messagesReady", "Ready"),
    num("messagesUnacked", "Unacknowledged"),
    num("publishRate", "Publish /s"),
    num("deliverRate", "Deliver /s"),
    num("ackRate", "Ack /s"),
    f("alarms", "Alarms", ro),
    f("listeners", "Listeners", ro),
    f("ratesMode", "Rates Mode", ro),
  ],
  outputs: [
    o("managementUrl", "Management API URL"),
    o("amqpUrl", "AMQP URL (no credentials)"),
    o("definitions", "Definitions (JSON)", { hidden: true, sensitive: true }),
  ],
  supportsUpdate: true,
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "server",
});

export const NodeResourceType = rt({
  name: "Node",
  id: "rabbitmq-node",
  description:
    "A cluster node: memory and disk against their alarm thresholds, file descriptors, sockets, Erlang processes, uptime and network partitions. The Metrics tab charts the node's resource use.",
  fields: [
    f("name", "Name", ro),
    f("type", "Type", ro),
    bool("running", "Running"),
    num("uptimeSeconds", "Uptime (s)"),
    num("memUsed", "Memory Used (bytes)"),
    num("memLimit", "Memory High Watermark (bytes)"),
    bool("memAlarm", "Memory Alarm"),
    num("diskFree", "Disk Free (bytes)"),
    num("diskFreeLimit", "Disk Free Limit (bytes)"),
    bool("diskFreeAlarm", "Disk Alarm"),
    num("fdUsed", "File Descriptors Used"),
    num("fdTotal", "File Descriptors Available"),
    num("socketsUsed", "Sockets Used"),
    num("socketsTotal", "Sockets Available"),
    num("procUsed", "Erlang Processes"),
    num("procTotal", "Erlang Process Limit"),
    num("runQueue", "Run Queue"),
    num("processors", "Processors"),
    f("partitions", "Partitioned From", ro),
    f("enabledPlugins", "Enabled Plugins", ro),
  ],
  outputs: [o("name", "Node name")],
  postureChecks: [
    {
      id: "rabbitmq-node-partitioned",
      title: "Node sees a network partition",
      severity: "high",
      category: "other",
      conditions: [{ fieldKey: "partitions", when: "notEquals", value: "" }],
      reason:
        "The node reports partitions with other cluster members; queues may have diverged until the partition is healed.",
    },
  ],
  supportsMetrics: true,
  supportsDelete: false,
  iconKey: "server",
});

export const VhostResourceType = rt({
  name: "Virtual Host",
  id: "rabbitmq-vhost",
  description:
    "A virtual host: its own exchanges, queues, bindings, policies and permissions. Create one, edit its description, tags, default queue type, limits and deletion protection, or delete it with everything in it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("description", "Description", { required: false }),
    f("tags", "Tags", { required: false, description: "Comma-separated." }),
    f("defaultQueueType", "Default Queue Type", {
      kind: "enum",
      enumValues: QUEUE_TYPES,
      required: false,
      description: "Type given to queues declared without x-queue-type.",
    }),
    f("tracing", "Message Tracing", { kind: "boolean", required: false }),
    f("protectedFromDeletion", "Protected From Deletion", { kind: "boolean", required: false }),
    f("maxConnections", "Max Connections", {
      kind: "number",
      required: false,
      description: "Empty or -1 removes the limit; 0 refuses all client connections.",
    }),
    f("maxQueues", "Max Queues", {
      kind: "number",
      required: false,
      description: "Empty or -1 removes the limit.",
    }),
    num("messages", "Messages"),
    num("messagesReady", "Ready"),
    num("messagesUnacked", "Unacknowledged"),
    num("publishRate", "Publish /s"),
    num("deliverRate", "Deliver /s"),
    f("state", "State", ro),
  ],
  outputs: [o("name", "Virtual host name")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "folder",
});

export const ExchangeResourceType = rt({
  name: "Exchange",
  id: "rabbitmq-exchange",
  parentTypeId: "rabbitmq-vhost",
  showInSidebar: true,
  description:
    "An exchange and its message rates. Declare one, delete it, see the bindings it routes through, and publish test messages from the Publish tab.",
  fields: [
    vhostField,
    f("name", "Name", ro),
    f("type", "Type", ro),
    bool("durable", "Durable"),
    bool("autoDelete", "Auto Delete"),
    bool("internal", "Internal"),
    f("arguments", "Arguments", ro),
    f("policy", "Policy", ro),
    num("publishInRate", "Publish In /s"),
    num("publishOutRate", "Publish Out /s"),
  ],
  outputs: [o("name", "Exchange name"), o("vhost", "Virtual host")],
  dependsOn: [inVhost],
  supportsCreate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "network",
});

export const QueueResourceType = rt({
  name: "Queue",
  id: "rabbitmq-queue",
  parentTypeId: "rabbitmq-vhost",
  showInSidebar: true,
  description:
    "A classic or quorum queue, or a stream: depth, consumers, memory, effective policy and message rates. Declare, purge or delete it, peek at messages in the Describe tab (they are requeued), and publish to it through the default exchange.",
  fields: [
    vhostField,
    f("name", "Name", ro),
    f("queueType", "Type", ro),
    f("state", "State", ro),
    bool("durable", "Durable"),
    bool("autoDelete", "Auto Delete"),
    bool("exclusive", "Exclusive"),
    f("arguments", "Arguments", ro),
    f("node", "Node / Leader", ro),
    f("members", "Members", ro),
    num("messages", "Messages"),
    num("messagesReady", "Ready"),
    num("messagesUnacked", "Unacknowledged"),
    num("messageBytes", "Message Bytes"),
    num("consumers", "Consumers"),
    num("consumerCapacity", "Consumer Capacity"),
    num("memory", "Memory (bytes)"),
    f("policy", "Policy", ro),
    f("operatorPolicy", "Operator Policy", ro),
    f("effectivePolicy", "Effective Policy", ro),
    f("idleSince", "Idle Since", ro),
    num("publishRate", "Publish /s"),
    num("deliverRate", "Deliver /s"),
    num("ackRate", "Ack /s"),
    num("redeliverRate", "Redeliver /s"),
  ],
  outputs: [o("name", "Queue name"), o("vhost", "Virtual host")],
  dependsOn: [inVhost],
  orphanRule: {
    conditions: [
      { fieldKey: "consumers", when: "equals", value: "0" },
      { fieldKey: "messages", when: "equals", value: "0" },
    ],
    reason: "The queue has no consumers and no messages.",
  },
  supportsCreate: true,
  supportsDelete: true,
  supportsMetrics: true,
  iconKey: "inbox",
});

export const BindingResourceType = rt({
  name: "Binding",
  id: "rabbitmq-binding",
  parentTypeId: "rabbitmq-vhost",
  showInSidebar: true,
  description:
    "A binding from an exchange to a queue or another exchange, with its routing key and arguments. Bindings cannot change in place: create a new one and delete the old.",
  fields: [
    vhostField,
    f("source", "Source Exchange", ro),
    f("destinationType", "Destination Type", ro),
    f("destination", "Destination", ro),
    f("routingKey", "Routing Key", ro),
    f("arguments", "Arguments", ro),
    f("propertiesKey", "Properties Key", ro),
    f("sourceRef", "Source Exchange Ref", ro),
    f("destinationQueueRef", "Destination Queue Ref", ro),
    f("destinationExchangeRef", "Destination Exchange Ref", ro),
  ],
  dependsOn: [
    { fieldKey: "sourceRef", targetTypeId: "rabbitmq-exchange", label: "from" },
    { fieldKey: "destinationQueueRef", targetTypeId: "rabbitmq-queue", label: "to" },
    { fieldKey: "destinationExchangeRef", targetTypeId: "rabbitmq-exchange", label: "to" },
  ],
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "link",
});

const policyFields = (applyTo: string[]) => [
  vhostField,
  f("name", "Name", ro),
  f("pattern", "Pattern", {
    required: false,
    description: "Regular expression matched against queue or exchange names.",
  }),
  f("applyTo", "Applies To", { kind: "enum", enumValues: applyTo, required: false }),
  f("priority", "Priority", {
    kind: "number",
    required: false,
    description: "The matching policy with the highest priority wins.",
  }),
  f("definition", "Definition", ro),
  num("keys", "Keys"),
];

export const PolicyResourceType = rt({
  name: "Policy",
  plural: "Policies",
  id: "rabbitmq-policy",
  parentTypeId: "rabbitmq-vhost",
  showInSidebar: true,
  description:
    "A user policy: queue and exchange settings (TTLs, length limits, dead lettering, federation, quorum group size) applied by name pattern. Create, edit the pattern, priority and JSON definition, or delete it.",
  fields: policyFields(POLICY_APPLY_TO),
  outputs: [o("name", "Policy name")],
  dependsOn: [inVhost],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "shield",
});

export const OperatorPolicyResourceType = rt({
  name: "Operator Policy",
  plural: "Operator Policies",
  id: "rabbitmq-operator-policy",
  parentTypeId: "rabbitmq-vhost",
  showInSidebar: true,
  description:
    "An operator policy: guardrails (max length, TTLs, delivery limits) that cap what user policies can set on queues. Create, edit or delete it.",
  fields: policyFields(OPERATOR_POLICY_APPLY_TO),
  outputs: [o("name", "Policy name")],
  dependsOn: [inVhost],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "shield",
});

export const UserResourceType = rt({
  name: "User",
  id: "rabbitmq-user",
  description:
    "A user in RabbitMQ's internal user store (LDAP and OAuth users do not appear). Create one, change its tags, password and connection or channel limits, or delete it.",
  fields: [
    f("name", "Name", { editable: false }),
    f("tags", "Tags", {
      required: false,
      description: `Comma-separated: ${USER_TAGS.join(", ")}.`,
    }),
    bool("hasPassword", "Password Set"),
    f("hashingAlgorithm", "Hashing Algorithm", ro),
    f("maxConnections", "Max Connections", {
      kind: "number",
      required: false,
      description: "Empty or -1 removes the limit.",
    }),
    f("maxChannels", "Max Channels", {
      kind: "number",
      required: false,
      description: "Empty or -1 removes the limit.",
    }),
    f("vhosts", "Virtual Hosts", ro),
    bool("isSelf", "Used By This Connection"),
  ],
  outputs: [o("name", "Username")],
  postureChecks: [
    {
      id: "rabbitmq-user-guest",
      title: "Default guest user exists",
      severity: "medium",
      category: "other",
      conditions: [{ fieldKey: "name", when: "equals", value: "guest" }],
      reason:
        "The guest user has a well-known password. It is limited to localhost by default, but should be deleted on any shared cluster.",
    },
  ],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  iconKey: "user",
});

export const PermissionResourceType = rt({
  name: "Permission",
  id: "rabbitmq-permission",
  parentTypeId: "rabbitmq-vhost",
  showInSidebar: true,
  description:
    "What a user may configure, write and read in a virtual host, as regular expressions over resource names. Grant, edit or revoke it.",
  fields: [
    vhostField,
    f("user", "User", ro),
    f("configure", "Configure", { required: false }),
    f("write", "Write", { required: false }),
    f("read", "Read", { required: false }),
  ],
  dependsOn: [inVhost, forUser("for")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "key",
});

export const TopicPermissionResourceType = rt({
  name: "Topic Permission",
  id: "rabbitmq-topic-permission",
  parentTypeId: "rabbitmq-vhost",
  showInSidebar: true,
  description:
    "Routing-key restrictions for a user on one topic exchange: which keys it may publish (write) and bind (read) with. Grant, edit or revoke it.",
  fields: [
    vhostField,
    f("user", "User", ro),
    f("exchange", "Exchange", ro),
    f("write", "Write", { required: false }),
    f("read", "Read", { required: false }),
  ],
  dependsOn: [inVhost, forUser("for")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "key",
});

export const ConnectionResourceType = rt({
  name: "Connection",
  id: "rabbitmq-connection",
  description:
    "An open client connection (AMQP 0-9-1, AMQP 1.0, MQTT, STOMP): who opened it, from where, with which client, its channels and traffic. Close it from its page.",
  fields: [
    f("name", "Name", ro),
    vhostField,
    f("user", "User", ro),
    f("protocol", "Protocol", ro),
    f("peer", "Client Address", ro),
    f("client", "Client", ro),
    f("connectionName", "Connection Name", ro),
    f("state", "State", ro),
    bool("tls", "TLS"),
    num("channels", "Channels"),
    num("recvRate", "Received (bytes/s)"),
    num("sendRate", "Sent (bytes/s)"),
    f("connectedAt", "Connected At", ro),
    f("node", "Node", ro),
  ],
  dependsOn: [inVhost, forUser("as")],
  supportsDelete: true,
  pinnable: false,
  iconKey: "plug",
});

export const ChannelResourceType = rt({
  name: "Channel",
  id: "rabbitmq-channel",
  parentTypeId: "rabbitmq-connection",
  description:
    "A channel on a connection: prefetch, unacknowledged messages, consumers and confirm or transaction mode. Read only; close the connection to close its channels.",
  fields: [
    f("name", "Name", ro),
    vhostField,
    f("user", "User", ro),
    f("connection", "Connection", ro),
    num("number", "Number"),
    f("state", "State", ro),
    num("prefetch", "Prefetch"),
    num("unacked", "Unacknowledged"),
    num("consumers", "Consumers"),
    bool("confirm", "Publisher Confirms"),
    bool("transactional", "Transactional"),
    num("publishRate", "Publish /s"),
    num("deliverRate", "Deliver /s"),
  ],
  pinnable: false,
  iconKey: "activity",
});

export const ShovelResourceType = rt({
  name: "Shovel",
  id: "rabbitmq-shovel",
  parentTypeId: "rabbitmq-vhost",
  showInSidebar: true,
  description:
    "A dynamic shovel moving messages from a source queue or exchange to a destination, possibly on another broker: state, URIs and counters. Create, restart or delete it. Needs the rabbitmq_shovel_management plugin.",
  fields: [
    vhostField,
    f("name", "Name", ro),
    f("state", "State", ro),
    f("type", "Type", ro),
    f("node", "Node", ro),
    f("srcProtocol", "Source Protocol", ro),
    f("srcUri", "Source URI", ro),
    f("srcQueue", "Source Queue", ro),
    f("srcExchange", "Source Exchange", ro),
    f("srcExchangeKey", "Source Routing Key", ro),
    f("destProtocol", "Destination Protocol", ro),
    f("destUri", "Destination URI", ro),
    f("destQueue", "Destination Queue", ro),
    f("destExchange", "Destination Exchange", ro),
    f("ackMode", "Ack Mode", ro),
    num("forwarded", "Forwarded"),
    num("remaining", "Remaining"),
    f("reason", "Termination Reason", ro),
  ],
  dependsOn: [inVhost],
  supportsCreate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "shuffle",
});

export const FederationUpstreamResourceType = rt({
  name: "Federation Upstream",
  id: "rabbitmq-federation-upstream",
  parentTypeId: "rabbitmq-vhost",
  showInSidebar: true,
  description:
    "A federation upstream: a remote broker this cluster federates exchanges or queues from, with prefetch, reconnect delay and ack mode, plus the status of its links. Create, edit or delete it; a policy with federation-upstream or federation-upstream-set turns it on.",
  fields: [
    vhostField,
    f("name", "Name", ro),
    f("uri", "URI", { required: false, description: "amqp:// or amqps:// URI of the upstream." }),
    f("exchange", "Upstream Exchange", { required: false }),
    f("queue", "Upstream Queue", { required: false }),
    f("prefetchCount", "Prefetch Count", { kind: "number", required: false }),
    f("reconnectDelay", "Reconnect Delay (s)", { kind: "number", required: false }),
    f("ackMode", "Ack Mode", {
      kind: "enum",
      enumValues: ["on-confirm", "on-publish", "no-ack"],
      required: false,
    }),
    f("trustUserId", "Trust User ID", { kind: "boolean", required: false }),
    f("maxHops", "Max Hops", { kind: "number", required: false }),
    f("expires", "Expires (ms)", { kind: "number", required: false }),
    f("messageTtl", "Message TTL (ms)", { kind: "number", required: false }),
    num("links", "Links"),
    f("linkStatus", "Link Status", ro),
    f("linkError", "Last Link Error", ro),
  ],
  dependsOn: [inVhost],
  supportsCreate: true,
  supportsUpdate: true,
  supportsDelete: true,
  pinnable: false,
  iconKey: "globe",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  ClusterResourceType,
  NodeResourceType,
  VhostResourceType,
  ExchangeResourceType,
  QueueResourceType,
  BindingResourceType,
  PolicyResourceType,
  OperatorPolicyResourceType,
  UserResourceType,
  PermissionResourceType,
  TopicPermissionResourceType,
  ConnectionResourceType,
  ChannelResourceType,
  ShovelResourceType,
  FederationUpstreamResourceType,
];
