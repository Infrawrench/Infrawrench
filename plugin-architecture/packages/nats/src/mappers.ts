/**
 * Raw monitoring shapes (only what the plugin reads) and their mapping to
 * `ResourceInstance`s. Field names were checked against live demo.nats.io
 * responses (nats-server 2.15, 2026-10); `/jsz` totals moved from
 * `total_streams`/`total_consumers` to `streams`/`consumers`, and both are read.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { joinId, nsToSeconds } from "./api.js";

export const PLUGIN_ID = "nats";

export interface Varz {
  server_id?: string;
  server_name?: string;
  version?: string;
  go?: string;
  host?: string;
  port?: number;
  max_connections?: number;
  max_payload?: number;
  start?: string;
  uptime?: string;
  mem?: number;
  cores?: number;
  cpu?: number;
  connections?: number;
  total_connections?: number;
  routes?: number;
  remotes?: number;
  leafnodes?: number;
  in_msgs?: number;
  out_msgs?: number;
  in_bytes?: number;
  out_bytes?: number;
  slow_consumers?: number;
  subscriptions?: number;
  tls_required?: boolean;
  auth_required?: boolean;
  tls_cert_not_after?: string;
  config_load_time?: string;
  cluster?: { name?: string };
  jetstream?: {
    config?: { max_memory?: number; max_storage?: number };
    stats?: { memory?: number; storage?: number; api?: { errors?: number } };
  };
}

export interface Jsz {
  memory?: number;
  storage?: number;
  streams?: number;
  consumers?: number;
  total_streams?: number;
  total_consumers?: number;
  config?: { max_memory?: number; max_storage?: number };
  api?: { errors?: number; total?: number };
  account_details?: JsAccount[];
}

export interface JsAccount {
  name?: string;
  id?: string;
  memory?: number;
  storage?: number;
  stream_detail?: JsStream[] | null;
}

export interface JsStream {
  name?: string;
  created?: string;
  cluster?: { leader?: string; replicas?: Array<{ name?: string; current?: boolean }> };
  config?: Record<string, unknown>;
  state?: {
    messages?: number;
    bytes?: number;
    first_seq?: number;
    last_seq?: number;
    last_ts?: string;
    num_subjects?: number;
    consumer_count?: number;
  };
  consumer_detail?: JsConsumer[] | null;
}

export interface JsConsumer {
  stream_name?: string;
  name?: string;
  created?: string;
  config?: Record<string, unknown>;
  delivered?: { stream_seq?: number; last_active?: string };
  ack_floor?: { stream_seq?: number };
  num_ack_pending?: number;
  num_redelivered?: number;
  num_waiting?: number;
  num_pending?: number;
  push_bound?: boolean;
}

export interface AccStat {
  acc?: string;
  name?: string;
  conns?: number;
  leafnodes?: number;
  total_conns?: number;
  num_subscriptions?: number;
  sent?: { msgs?: number; bytes?: number };
  received?: { msgs?: number; bytes?: number };
  slow_consumers?: number;
}

export interface Conn {
  cid?: number;
  kind?: string;
  type?: string;
  ip?: string;
  port?: number;
  name?: string;
  lang?: string;
  version?: string;
  account?: string;
  authorized_user?: string;
  uptime?: string;
  idle?: string;
  rtt?: string;
  subscriptions?: number;
  in_msgs?: number;
  out_msgs?: number;
  pending_bytes?: number;
  tls_version?: string;
}

type FieldValue = string | number | boolean | undefined | null;

export function instance(
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

const limit = (v: unknown): number | undefined => (typeof v === "number" && v > 0 ? v : undefined);
const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function mapServer(
  accountId: string,
  monitoringUrl: string,
  v: Varz,
  js: Jsz | undefined,
  health: string,
): ResourceInstance {
  const host = (() => {
    try {
      return new URL(monitoringUrl).hostname;
    } catch {
      return "";
    }
  })();
  const clientUrl = host && v.port ? `${v.tls_required ? "tls" : "nats"}://${host}:${v.port}` : "";
  const r = instance(accountId, "nats-server", "server", v.server_name || host || "nats-server", {
    serverName: v.server_name,
    serverId: v.server_id,
    version: v.version,
    goVersion: v.go,
    clientUrl,
    cluster: v.cluster?.name,
    health,
    uptime: v.uptime,
    start: v.start,
    connections: v.connections,
    maxConnections: v.max_connections,
    totalConnections: v.total_connections,
    subscriptions: v.subscriptions,
    slowConsumers: v.slow_consumers,
    inMsgs: v.in_msgs,
    outMsgs: v.out_msgs,
    inBytes: v.in_bytes,
    outBytes: v.out_bytes,
    memory: v.mem,
    cpu: v.cpu,
    cores: v.cores,
    maxPayload: v.max_payload,
    routes: v.routes,
    gateways: v.remotes,
    leafnodes: v.leafnodes,
    tlsRequired: v.tls_required,
    authRequired: v.auth_required,
    tlsCertNotAfter:
      v.tls_cert_not_after && !v.tls_cert_not_after.startsWith("0001")
        ? v.tls_cert_not_after
        : undefined,
    jetstream: !!v.jetstream?.config,
    jsStorage: js?.storage ?? v.jetstream?.stats?.storage,
    jsMaxStorage: js?.config?.max_storage ?? v.jetstream?.config?.max_storage,
    jsMemory: js?.memory ?? v.jetstream?.stats?.memory,
    jsMaxMemory: js?.config?.max_memory ?? v.jetstream?.config?.max_memory,
    jsStreams: js?.streams ?? js?.total_streams,
    jsConsumers: js?.consumers ?? js?.total_consumers,
    jsApiErrors: js?.api?.errors ?? v.jetstream?.stats?.api?.errors,
    configLoadTime: v.config_load_time,
  });
  r.resolvedOutputs = { ...(clientUrl ? { clientUrl } : {}), monitoringUrl };
  return r;
}

export const accountRef = (accountId: string, name: string) =>
  `${accountId}:nats-account:${joinId(name)}`;

/** KV buckets and object stores are streams named `KV_<bucket>` and `OBJ_<bucket>`. */
export function streamKind(name: string): string {
  if (name.startsWith("KV_")) return "key-value bucket";
  if (name.startsWith("OBJ_")) return "object store";
  return "stream";
}

export function mapStream(accountId: string, account: string, st: JsStream): ResourceInstance {
  const c = st.config ?? {};
  const name = st.name ?? s(c["name"]) ?? "";
  const r = instance(
    accountId,
    "nats-stream",
    joinId(account, name),
    name,
    {
      account,
      name,
      kind: streamKind(name),
      description: s(c["description"]),
      subjects: Array.isArray(c["subjects"]) ? (c["subjects"] as string[]).join(", ") : undefined,
      retention: s(c["retention"]),
      storage: s(c["storage"]),
      replicas: typeof c["num_replicas"] === "number" ? (c["num_replicas"] as number) : undefined,
      discard: s(c["discard"]),
      maxMsgs: limit(c["max_msgs"]),
      maxBytes: limit(c["max_bytes"]),
      maxAgeSeconds: nsToSeconds(c["max_age"]),
      maxMsgsPerSubject: limit(c["max_msgs_per_subject"]),
      maxMsgSize: limit(c["max_msg_size"]),
      duplicateWindowSeconds: nsToSeconds(c["duplicate_window"]),
      compression: s(c["compression"]),
      sealed: typeof c["sealed"] === "boolean" ? (c["sealed"] as boolean) : undefined,
      denyDelete: typeof c["deny_delete"] === "boolean" ? (c["deny_delete"] as boolean) : undefined,
      denyPurge: typeof c["deny_purge"] === "boolean" ? (c["deny_purge"] as boolean) : undefined,
      messages: st.state?.messages,
      bytes: st.state?.bytes,
      firstSeq: st.state?.first_seq,
      lastSeq: st.state?.last_seq,
      lastTs:
        st.state?.last_ts && !st.state.last_ts.startsWith("0001") ? st.state.last_ts : undefined,
      subjectCount: st.state?.num_subjects,
      consumers: st.state?.consumer_count,
      leader: st.cluster?.leader,
      created: st.created,
    },
    { parentResourceId: accountRef(accountId, account) },
  );
  if (st.config) r.resolvedOutputs = { name, config: JSON.stringify(st.config) };
  else r.resolvedOutputs = { name };
  return r;
}

export function mapConsumer(
  accountId: string,
  account: string,
  cons: JsConsumer,
): ResourceInstance {
  const c = cons.config ?? {};
  const stream = cons.stream_name ?? "";
  const name = cons.name ?? "";
  const filters = Array.isArray(c["filter_subjects"])
    ? (c["filter_subjects"] as string[])
    : s(c["filter_subject"])
      ? [c["filter_subject"] as string]
      : [];
  const r = instance(
    accountId,
    "nats-consumer",
    joinId(account, stream, name),
    name,
    {
      account,
      stream,
      name,
      // Ephemeral consumers carry an inactive_threshold; durable ones a durable_name or none.
      durable: cons.config
        ? !!s(c["durable_name"]) || c["inactive_threshold"] === undefined
        : undefined,
      mode: s(c["deliver_subject"]) ? "push" : cons.config ? "pull" : undefined,
      deliverPolicy: s(c["deliver_policy"]),
      ackPolicy: s(c["ack_policy"]),
      ackWaitSeconds: nsToSeconds(c["ack_wait"]),
      maxDeliver: limit(c["max_deliver"]),
      maxAckPending: limit(c["max_ack_pending"]),
      filterSubjects: filters.join(", "),
      deliverSubject: s(c["deliver_subject"]),
      replayPolicy: s(c["replay_policy"]),
      pending: cons.num_pending,
      ackPending: cons.num_ack_pending,
      redelivered: cons.num_redelivered,
      waiting: cons.num_waiting,
      deliveredStreamSeq: cons.delivered?.stream_seq,
      ackFloorStreamSeq: cons.ack_floor?.stream_seq,
      lastActive:
        cons.delivered?.last_active && !cons.delivered.last_active.startsWith("0001")
          ? cons.delivered.last_active
          : undefined,
      pushBound: cons.push_bound,
      created: cons.created,
    },
    { parentResourceId: `${accountId}:nats-stream:${joinId(account, stream)}` },
  );
  if (cons.config) r.resolvedOutputs = { config: JSON.stringify(cons.config) };
  return r;
}

export function mapAccount(
  accountId: string,
  name: string,
  stat: AccStat | undefined,
  js: JsAccount | undefined,
  system: string | undefined,
): ResourceInstance {
  const streams = js?.stream_detail ?? [];
  return instance(accountId, "nats-account", joinId(name), name, {
    name,
    system: system ? system === name : undefined,
    connections: stat?.conns,
    totalConnections: stat?.total_conns,
    leafnodes: stat?.leafnodes,
    subscriptions: stat?.num_subscriptions,
    sentMsgs: stat?.sent?.msgs,
    receivedMsgs: stat?.received?.msgs,
    sentBytes: stat?.sent?.bytes,
    receivedBytes: stat?.received?.bytes,
    slowConsumers: stat?.slow_consumers,
    jsStorage: js?.storage,
    jsMemory: js?.memory,
    streams: js ? streams.length : undefined,
    consumers: js ? streams.reduce((n, st) => n + (st.state?.consumer_count ?? 0), 0) : undefined,
  });
}

export function mapConnection(accountId: string, c: Conn): ResourceInstance {
  const client = [c.lang, c.version].filter(Boolean).join(" ");
  return instance(
    accountId,
    "nats-connection",
    String(c.cid ?? ""),
    c.name || `${c.ip ?? ""}:${c.port ?? ""}`,
    {
      cid: c.cid,
      name: c.name,
      address: c.ip ? `${c.ip}:${c.port ?? ""}` : undefined,
      account: c.account,
      user: c.authorized_user,
      client: client || undefined,
      kind: [c.kind, c.type].filter(Boolean).join(" / ") || undefined,
      uptime: c.uptime,
      idle: c.idle,
      rtt: c.rtt,
      subscriptions: c.subscriptions,
      inMsgs: c.in_msgs,
      outMsgs: c.out_msgs,
      pendingBytes: c.pending_bytes,
      tls: c.tls_version,
    },
  );
}
