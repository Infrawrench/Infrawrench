/**
 * Raw management API shapes (only what the plugin reads) and their mapping
 * to `ResourceInstance`s. Field names follow the HTTP API reference and the
 * management plugin's formatters (rabbitmq-server `deps/rabbitmq_management`,
 * main branch, read 2026-10).
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { joinId } from "./api.js";

export const PLUGIN_ID = "rabbitmq";

export interface Details {
  rate?: number;
  samples?: Array<{ sample?: number; timestamp?: number }>;
}

export interface MessageStats {
  publish?: number;
  publish_details?: Details;
  publish_in_details?: Details;
  publish_out_details?: Details;
  deliver_get?: number;
  deliver_get_details?: Details;
  ack_details?: Details;
  redeliver_details?: Details;
  confirm_details?: Details;
  drop_unroutable_details?: Details;
  return_unroutable_details?: Details;
}

export interface Overview {
  cluster_name?: string;
  rabbitmq_version?: string;
  erlang_version?: string;
  management_version?: string;
  node?: string;
  rates_mode?: string;
  message_stats?: MessageStats;
  queue_totals?: {
    messages?: number;
    messages_details?: Details;
    messages_ready?: number;
    messages_ready_details?: Details;
    messages_unacknowledged?: number;
    messages_unacknowledged_details?: Details;
  };
  object_totals?: {
    connections?: number;
    channels?: number;
    exchanges?: number;
    queues?: number;
    consumers?: number;
  };
  listeners?: Array<{ node?: string; protocol?: string; ip_address?: string; port?: number }>;
}

export interface RabbitNode {
  name?: string;
  type?: string;
  running?: boolean;
  uptime?: number;
  mem_used?: number;
  mem_used_details?: Details;
  mem_limit?: number;
  mem_alarm?: boolean;
  disk_free?: number;
  disk_free_details?: Details;
  disk_free_limit?: number;
  disk_free_alarm?: boolean;
  fd_used?: number;
  fd_used_details?: Details;
  fd_total?: number;
  sockets_used?: number;
  sockets_used_details?: Details;
  sockets_total?: number;
  proc_used?: number;
  proc_used_details?: Details;
  proc_total?: number;
  run_queue?: number;
  processors?: number;
  partitions?: string[];
  enabled_plugins?: string[];
}

export interface Vhost {
  name?: string;
  description?: string;
  tags?: string[] | string;
  default_queue_type?: string;
  metadata?: { description?: string; tags?: string[]; default_queue_type?: string };
  tracing?: boolean;
  protected_from_deletion?: boolean;
  messages?: number;
  messages_ready?: number;
  messages_unacknowledged?: number;
  messages_details?: Details;
  message_stats?: MessageStats;
  cluster_state?: Record<string, string>;
}

export interface VhostLimits {
  vhost?: string;
  value?: Record<string, number>;
}

export interface Exchange {
  name?: string;
  vhost?: string;
  type?: string;
  durable?: boolean;
  auto_delete?: boolean;
  internal?: boolean;
  arguments?: Record<string, unknown>;
  policy?: string;
  message_stats?: MessageStats;
}

export interface Queue {
  name?: string;
  vhost?: string;
  type?: string;
  state?: string;
  durable?: boolean;
  auto_delete?: boolean;
  exclusive?: boolean;
  arguments?: Record<string, unknown>;
  node?: string;
  leader?: string;
  members?: string[];
  messages?: number;
  messages_details?: Details;
  messages_ready?: number;
  messages_ready_details?: Details;
  messages_unacknowledged?: number;
  messages_unacknowledged_details?: Details;
  message_bytes?: number;
  consumers?: number;
  consumer_capacity?: number;
  consumer_utilisation?: number;
  memory?: number;
  policy?: string | null;
  operator_policy?: string | null;
  effective_policy_definition?: Record<string, unknown>;
  idle_since?: string;
  message_stats?: MessageStats;
  consumer_details?: Array<{
    consumer_tag?: string;
    prefetch_count?: number;
    ack_required?: boolean;
    active?: boolean;
    channel_details?: {
      name?: string;
      connection_name?: string;
      user?: string;
      peer_host?: string;
    };
  }>;
}

export interface Binding {
  source?: string;
  vhost?: string;
  destination?: string;
  destination_type?: string;
  routing_key?: string;
  arguments?: Record<string, unknown>;
  properties_key?: string;
}

export interface Policy {
  vhost?: string;
  name?: string;
  pattern?: string;
  "apply-to"?: string;
  definition?: Record<string, unknown>;
  priority?: number;
}

export interface User {
  name?: string;
  tags?: string[] | string;
  password_hash?: string;
  hashing_algorithm?: string;
  limits?: Record<string, number>;
}

export interface Permission {
  user?: string;
  vhost?: string;
  configure?: string;
  write?: string;
  read?: string;
  exchange?: string;
}

export interface Connection {
  name?: string;
  vhost?: string;
  user?: string;
  protocol?: string;
  peer_host?: string;
  peer_port?: number;
  host?: string;
  port?: number;
  node?: string;
  state?: string;
  ssl?: boolean;
  channels?: number;
  connected_at?: number;
  recv_oct_details?: Details;
  send_oct_details?: Details;
  client_properties?: {
    product?: string;
    version?: string;
    platform?: string;
    connection_name?: string;
  };
}

export interface Channel {
  name?: string;
  number?: number;
  vhost?: string;
  user?: string;
  state?: string;
  prefetch_count?: number;
  global_prefetch_count?: number;
  messages_unacknowledged?: number;
  consumer_count?: number;
  confirm?: boolean;
  transactional?: boolean;
  message_stats?: MessageStats;
  connection_details?: { name?: string; peer_host?: string; peer_port?: number };
}

export interface ShovelStatus {
  name?: string;
  vhost?: string;
  type?: string;
  state?: string;
  node?: string;
  reason?: string;
  src_uri?: string;
  dest_uri?: string;
  src_protocol?: string;
  dest_protocol?: string;
  src_queue?: string;
  src_exchange?: string;
  dest_queue?: string;
  dest_exchange?: string;
  forwarded?: number;
  remaining?: number;
}

export interface RuntimeParameter {
  vhost?: string;
  component?: string;
  name?: string;
  value?: Record<string, unknown>;
}

export interface FederationLink {
  upstream?: string;
  vhost?: string;
  status?: string;
  error?: string;
  type?: string;
  exchange?: string;
  queue?: string;
}

type FieldValue = string | number | boolean | undefined | null;

function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  extra: Partial<ResourceInstance> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) clean[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: {},
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

export const rate = (d: Details | undefined): number | undefined =>
  typeof d?.rate === "number" ? Math.round(d.rate * 100) / 100 : undefined;

export function tagList(tags: string[] | string | undefined): string[] {
  if (Array.isArray(tags)) return tags.filter(Boolean);
  return (tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export const jsonText = (v: Record<string, unknown> | undefined): string | undefined =>
  v && Object.keys(v).length ? JSON.stringify(v) : undefined;

export const vhostId = (name: string): string => joinId(name);
export const vhostParent = (accountId: string, vhost: string): string =>
  `${accountId}:rabbitmq-vhost:${vhostId(vhost)}`;

export function mapCluster(
  accountId: string,
  baseUrl: string,
  o: Overview,
  nodes: number | undefined,
  alarms: string,
): ResourceInstance {
  const listeners = o.listeners ?? [];
  const host = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return "";
    }
  })();
  const amqp =
    listeners.find((l) => l.protocol === "amqp/ssl") ??
    listeners.find((l) => l.protocol === "amqp");
  const amqpUrl =
    amqp && host ? `${amqp.protocol === "amqp/ssl" ? "amqps" : "amqp"}://${host}:${amqp.port}` : "";
  const r = instance(
    accountId,
    "rabbitmq-cluster",
    "cluster",
    o.cluster_name || host || "RabbitMQ",
    {
      clusterName: o.cluster_name,
      rabbitmqVersion: o.rabbitmq_version,
      erlangVersion: o.erlang_version,
      managementVersion: o.management_version,
      node: o.node,
      nodes,
      connections: o.object_totals?.connections,
      channels: o.object_totals?.channels,
      exchanges: o.object_totals?.exchanges,
      queues: o.object_totals?.queues,
      consumers: o.object_totals?.consumers,
      messages: o.queue_totals?.messages,
      messagesReady: o.queue_totals?.messages_ready,
      messagesUnacked: o.queue_totals?.messages_unacknowledged,
      publishRate: rate(o.message_stats?.publish_details),
      deliverRate: rate(o.message_stats?.deliver_get_details),
      ackRate: rate(o.message_stats?.ack_details),
      alarms,
      listeners: [...new Set(listeners.map((l) => `${l.protocol}:${l.port}`))].join(", "),
      ratesMode: o.rates_mode,
    },
  );
  r.resolvedOutputs = { managementUrl: baseUrl, ...(amqpUrl ? { amqpUrl } : {}) };
  return r;
}

export function mapNode(accountId: string, n: RabbitNode): ResourceInstance {
  const name = n.name ?? "";
  return instance(accountId, "rabbitmq-node", name, name, {
    name,
    type: n.type,
    running: n.running,
    uptimeSeconds: typeof n.uptime === "number" ? Math.floor(n.uptime / 1000) : undefined,
    memUsed: n.mem_used,
    memLimit: n.mem_limit,
    memAlarm: n.mem_alarm,
    diskFree: n.disk_free,
    diskFreeLimit: n.disk_free_limit,
    diskFreeAlarm: n.disk_free_alarm,
    fdUsed: n.fd_used,
    fdTotal: n.fd_total,
    socketsUsed: n.sockets_used,
    socketsTotal: n.sockets_total,
    procUsed: n.proc_used,
    procTotal: n.proc_total,
    runQueue: n.run_queue,
    processors: n.processors,
    partitions: (n.partitions ?? []).join(", "),
    enabledPlugins: (n.enabled_plugins ?? []).join(", "),
  });
}

export function mapVhost(
  accountId: string,
  v: Vhost,
  limits: Record<string, number> | undefined,
): ResourceInstance {
  const name = v.name ?? "";
  const states = Object.values(v.cluster_state ?? {});
  return instance(accountId, "rabbitmq-vhost", vhostId(name), name, {
    name,
    description: v.metadata?.description ?? v.description,
    tags: tagList(v.metadata?.tags ?? v.tags).join(", "),
    defaultQueueType: v.metadata?.default_queue_type ?? v.default_queue_type,
    tracing: v.tracing,
    protectedFromDeletion: v.protected_from_deletion,
    maxConnections: limits?.["max-connections"],
    maxQueues: limits?.["max-queues"],
    messages: v.messages,
    messagesReady: v.messages_ready,
    messagesUnacked: v.messages_unacknowledged,
    publishRate: rate(v.message_stats?.publish_details),
    deliverRate: rate(v.message_stats?.deliver_get_details),
    state: states.length
      ? states.every((s) => s === "running")
        ? "running"
        : [...new Set(states)].join(", ")
      : undefined,
  });
}

export function mapExchange(accountId: string, x: Exchange): ResourceInstance {
  const vhost = x.vhost ?? "/";
  const name = x.name ?? "";
  return instance(
    accountId,
    "rabbitmq-exchange",
    joinId(vhost, name),
    name,
    {
      vhost,
      name,
      type: x.type,
      durable: x.durable,
      autoDelete: x.auto_delete,
      internal: x.internal,
      arguments: jsonText(x.arguments),
      policy: x.policy || undefined,
      publishInRate: rate(x.message_stats?.publish_in_details),
      publishOutRate: rate(x.message_stats?.publish_out_details),
    },
    { parentResourceId: vhostParent(accountId, vhost) },
  );
}

export function mapQueue(accountId: string, q: Queue): ResourceInstance {
  const vhost = q.vhost ?? "/";
  const name = q.name ?? "";
  const capacity = q.consumer_capacity ?? q.consumer_utilisation;
  return instance(
    accountId,
    "rabbitmq-queue",
    joinId(vhost, name),
    name,
    {
      vhost,
      name,
      queueType: q.type,
      state: q.state,
      durable: q.durable,
      autoDelete: q.auto_delete,
      exclusive: q.exclusive,
      arguments: jsonText(q.arguments),
      node: q.leader ?? q.node,
      members: q.members?.length ? q.members.join(", ") : undefined,
      messages: q.messages,
      messagesReady: q.messages_ready,
      messagesUnacked: q.messages_unacknowledged,
      messageBytes: q.message_bytes,
      consumers: q.consumers,
      consumerCapacity: typeof capacity === "number" ? Math.round(capacity * 100) / 100 : undefined,
      memory: q.memory,
      policy: q.policy || undefined,
      operatorPolicy: q.operator_policy || undefined,
      effectivePolicy: jsonText(q.effective_policy_definition),
      idleSince: q.idle_since,
      publishRate: rate(q.message_stats?.publish_details),
      deliverRate: rate(q.message_stats?.deliver_get_details),
      ackRate: rate(q.message_stats?.ack_details),
      redeliverRate: rate(q.message_stats?.redeliver_details),
    },
    { parentResourceId: vhostParent(accountId, vhost) },
  );
}

/** Bindings id: vhost/source/destination type (q|e)/destination/properties key. */
export function bindingId(b: Binding): string {
  return joinId(
    b.vhost ?? "/",
    b.source ?? "",
    b.destination_type === "exchange" ? "e" : "q",
    b.destination ?? "",
    b.properties_key ?? "~",
  );
}

export function mapBinding(accountId: string, b: Binding): ResourceInstance {
  const vhost = b.vhost ?? "/";
  const source = b.source ?? "";
  const dest = b.destination ?? "";
  const toExchange = b.destination_type === "exchange";
  const key = b.routing_key ?? "";
  return instance(
    accountId,
    "rabbitmq-binding",
    bindingId(b),
    `${source} → ${dest}${key ? ` (${key})` : ""}`,
    {
      vhost,
      source,
      destinationType: b.destination_type,
      destination: dest,
      routingKey: key,
      arguments: jsonText(b.arguments),
      propertiesKey: b.properties_key,
      sourceRef: joinId(vhost, source),
      destinationQueueRef: toExchange ? undefined : joinId(vhost, dest),
      destinationExchangeRef: toExchange ? joinId(vhost, dest) : undefined,
    },
    { parentResourceId: vhostParent(accountId, vhost) },
  );
}

export function mapPolicy(
  accountId: string,
  typeId: "rabbitmq-policy" | "rabbitmq-operator-policy",
  p: Policy,
): ResourceInstance {
  const vhost = p.vhost ?? "/";
  const name = p.name ?? "";
  const r = instance(
    accountId,
    typeId,
    joinId(vhost, name),
    name,
    {
      vhost,
      name,
      pattern: p.pattern,
      applyTo: p["apply-to"],
      priority: p.priority,
      definition: JSON.stringify(p.definition ?? {}),
      keys: Object.keys(p.definition ?? {}).length,
    },
    { parentResourceId: vhostParent(accountId, vhost) },
  );
  r.resolvedOutputs = { name };
  return r;
}

export function mapUser(
  accountId: string,
  u: User,
  vhosts: string[],
  self: string | undefined,
): ResourceInstance {
  const name = u.name ?? "";
  return instance(accountId, "rabbitmq-user", joinId(name), name, {
    name,
    tags: tagList(u.tags).join(", "),
    hasPassword: u.password_hash !== undefined ? u.password_hash !== "" : undefined,
    hashingAlgorithm: u.hashing_algorithm,
    maxConnections: u.limits?.["max-connections"],
    maxChannels: u.limits?.["max-channels"],
    vhosts: vhosts.join(", "),
    isSelf: self !== undefined ? self === name : undefined,
  });
}

export function mapPermission(accountId: string, p: Permission): ResourceInstance {
  const vhost = p.vhost ?? "/";
  const user = p.user ?? "";
  return instance(
    accountId,
    "rabbitmq-permission",
    joinId(vhost, user),
    `${user} @ ${vhost}`,
    { vhost, user, configure: p.configure, write: p.write, read: p.read },
    { parentResourceId: vhostParent(accountId, vhost) },
  );
}

export function mapTopicPermission(accountId: string, p: Permission): ResourceInstance {
  const vhost = p.vhost ?? "/";
  const user = p.user ?? "";
  const exchange = p.exchange ?? "";
  return instance(
    accountId,
    "rabbitmq-topic-permission",
    joinId(vhost, user, exchange),
    `${user} @ ${exchange}`,
    { vhost, user, exchange, write: p.write, read: p.read },
    { parentResourceId: vhostParent(accountId, vhost) },
  );
}

export function mapConnection(accountId: string, c: Connection): ResourceInstance {
  const name = c.name ?? "";
  const cp = c.client_properties ?? {};
  const client = [cp.product, cp.version].filter(Boolean).join(" ");
  return instance(accountId, "rabbitmq-connection", joinId(name), cp.connection_name || name, {
    name,
    vhost: c.vhost,
    user: c.user,
    protocol: c.protocol,
    peer: c.peer_host ? `${c.peer_host}:${c.peer_port ?? ""}` : undefined,
    client: client || undefined,
    connectionName: cp.connection_name,
    state: c.state,
    tls: c.ssl,
    channels: c.channels,
    recvRate: rate(c.recv_oct_details),
    sendRate: rate(c.send_oct_details),
    connectedAt: typeof c.connected_at === "number" ? new Date(c.connected_at).toISOString() : "",
    node: c.node,
  });
}

export function mapChannel(accountId: string, ch: Channel): ResourceInstance {
  const name = ch.name ?? "";
  const conn = ch.connection_details?.name ?? "";
  return instance(
    accountId,
    "rabbitmq-channel",
    joinId(name),
    name,
    {
      name,
      vhost: ch.vhost,
      user: ch.user,
      connection: conn,
      number: ch.number,
      state: ch.state,
      prefetch: ch.prefetch_count,
      unacked: ch.messages_unacknowledged,
      consumers: ch.consumer_count,
      confirm: ch.confirm,
      transactional: ch.transactional,
      publishRate: rate(ch.message_stats?.publish_details),
      deliverRate: rate(ch.message_stats?.deliver_get_details),
    },
    conn ? { parentResourceId: `${accountId}:rabbitmq-connection:${joinId(conn)}` } : {},
  );
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;

/** Strip the password from an `amqp://user:pass@host` URI before it is stored. */
export function redactUri(uri: string | undefined): string | undefined {
  if (!uri) return uri;
  return uri.replace(/^(amqps?:\/\/[^:/@]*):[^@]*@/i, "$1:•••@");
}

export function mapShovel(
  accountId: string,
  vhost: string,
  name: string,
  def: Record<string, unknown> | undefined,
  status: ShovelStatus | undefined,
): ResourceInstance {
  const d = def ?? {};
  const firstUri = (v: unknown) => (Array.isArray(v) ? str(v[0]) : str(v));
  return instance(
    accountId,
    "rabbitmq-shovel",
    joinId(vhost, name),
    name,
    {
      vhost,
      name,
      state: status?.state ?? (def ? "not running" : undefined),
      type: status?.type ?? "dynamic",
      node: status?.node,
      srcProtocol: str(d["src-protocol"]) ?? status?.src_protocol,
      srcUri: redactUri(firstUri(d["src-uri"]) ?? status?.src_uri),
      srcQueue: str(d["src-queue"]) ?? str(d["src-address"]) ?? status?.src_queue,
      srcExchange: str(d["src-exchange"]) ?? status?.src_exchange,
      srcExchangeKey: str(d["src-exchange-key"]),
      destProtocol: str(d["dest-protocol"]) ?? status?.dest_protocol,
      destUri: redactUri(firstUri(d["dest-uri"]) ?? status?.dest_uri),
      destQueue: str(d["dest-queue"]) ?? str(d["dest-address"]) ?? status?.dest_queue,
      destExchange: str(d["dest-exchange"]) ?? status?.dest_exchange,
      ackMode: str(d["ack-mode"]),
      forwarded: status?.forwarded,
      remaining: status?.remaining,
      reason: status?.reason,
    },
    { parentResourceId: vhostParent(accountId, vhost) },
  );
}

export function mapFederationUpstream(
  accountId: string,
  p: RuntimeParameter,
  links: FederationLink[],
): ResourceInstance {
  const vhost = p.vhost ?? "/";
  const name = p.name ?? "";
  const v = p.value ?? {};
  const mine = links.filter((l) => l.upstream === name && (l.vhost ?? "/") === vhost);
  const statuses = [...new Set(mine.map((l) => l.status).filter(Boolean))];
  const num = (k: string) => (typeof v[k] === "number" ? (v[k] as number) : undefined);
  const uri = Array.isArray(v["uri"]) ? str(v["uri"][0]) : str(v["uri"]);
  return instance(
    accountId,
    "rabbitmq-federation-upstream",
    joinId(vhost, name),
    name,
    {
      vhost,
      name,
      uri: redactUri(uri),
      exchange: str(v["exchange"]),
      queue: str(v["queue"]),
      prefetchCount: num("prefetch-count"),
      reconnectDelay: num("reconnect-delay"),
      ackMode: str(v["ack-mode"]),
      trustUserId:
        typeof v["trust-user-id"] === "boolean" ? (v["trust-user-id"] as boolean) : undefined,
      maxHops: num("max-hops"),
      expires: num("expires"),
      messageTtl: num("message-ttl"),
      links: mine.length,
      linkStatus: statuses.join(", ") || undefined,
      linkError: mine.find((l) => l.error)?.error,
    },
    { parentResourceId: vhostParent(accountId, vhost) },
  );
}
