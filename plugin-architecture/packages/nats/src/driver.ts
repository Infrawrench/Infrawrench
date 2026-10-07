import {
  connect,
  credsAuthenticator,
  headers as natsHeaders,
  nkeyAuthenticator,
  type Authenticator,
  type MsgHdrs,
  type NatsConnection,
  type NodeConnectionOptions,
} from "@nats-io/transport-node";
import {
  jetstream,
  jetstreamManager,
  type ConsumerConfig,
  type JetStreamManager,
  type PurgeOpts,
  type StoredMsg,
  type StreamConfig,
} from "@nats-io/jetstream";
import { Kvm, type KvEntry, type KvOptions } from "@nats-io/kv";
import { Objm, type ObjectStoreOptions } from "@nats-io/obj";
import type { DialTarget, KvNodeDriver } from "@infrawrench/plugin-base";
import {
  decodeAuthArgs,
  describeServers,
  natsDialTargets,
  parseServers,
  type NatsAuth,
} from "./connection.js";

/**
 * NATS node driver, over the official NATS.js v3 client
 * (`@nats-io/transport-node` + `jetstream`/`kv`/`obj`).
 *
 * `connectionString` is the account's server list. Each command's first
 * argument may be the auth envelope from `connection.ts`; the rest are
 * positional, with structured values as JSON strings. Every command returns
 * plain JSON (it crosses Electron IPC and the cloud HTTP API).
 *
 *   info                                    → { server, account?, jetstream? }
 *   streams                                 → StreamInfo[]
 *   stream          (name)                  → StreamInfo
 *   stream-add      (configJson)            → StreamInfo
 *   stream-update   (name, configJson)      → StreamInfo
 *   stream-purge    (name, optsJson?)       → { purged }
 *   stream-delete   (name)                  → { ok }
 *   messages        (stream, optsJson?)     → { items, nextCursor? }
 *   message         (stream, seq)           → message | null
 *   message-delete  (stream, seq, erase?)   → { ok }
 *   consumers       (stream)                → ConsumerInfo[]
 *   consumer        (stream, name)          → ConsumerInfo
 *   consumer-add    (stream, configJson)    → ConsumerInfo
 *   consumer-update (stream, name, configJson) → ConsumerInfo
 *   consumer-delete (stream, name)          → { ok }
 *   consumer-pause  (stream, name, untilIso) → { paused, pause_until? }
 *   consumer-resume (stream, name)          → { paused }
 *   kv-create       (bucket, optsJson?)     → StreamInfo of KV_<bucket>
 *   kv-delete       (bucket)                → { ok }
 *   kv-keys         (bucket, filter?, limit?) → string[]
 *   kv-get          (bucket, key, revision?) → entry | null
 *   kv-put          (bucket, key, value)    → { revision }
 *   kv-del          (bucket, key, purge?)   → { ok }
 *   kv-history      (bucket, key?, limit?)  → entry[] (newest first)
 *   obj-create      (bucket, optsJson?)     → StreamInfo of OBJ_<bucket>
 *   obj-delete      (bucket)                → { ok }
 *   obj-list        (bucket)                → ObjectInfo[]
 *   obj-info        (bucket, name)          → ObjectInfo | null
 *   obj-get         (bucket, name, maxBytes?) → { info, data?, encoding?, truncated }
 *   obj-put         (bucket, name, base64, description?) → ObjectInfo
 *   obj-remove      (bucket, name)          → { ok }
 *   publish         (subject, body, headersJson?, mode?, timeoutMs?, msgId?)
 *                   mode core | jetstream | request → { stream?, seq?, duplicate?, reply? }
 */

const CONNECT_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 10000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_LIST = 1000;
const MAX_OBJECT_PREVIEW = 1024 * 1024;

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Connection options
// ---------------------------------------------------------------------------

/** nats.js options for a server list and auth. Exported for tests. */
export function buildConnectOptions(
  connectionString: string,
  auth: NatsAuth,
  withTls = true,
): NodeConnectionOptions {
  const servers = parseServers(connectionString);
  if (servers.length === 0) throw new Error("NATS driver: no server URL on this account");
  const fromUrl = servers.find((s) => s.user !== undefined);
  const opts: NodeConnectionOptions = {
    servers: servers.map((s) => s.hostPort),
    name: "infrawrench",
    timeout: CONNECT_TIMEOUT_MS,
    // The cloud egress guard vetted exactly these servers; do not follow
    // the cluster's gossiped connect_urls anywhere else.
    ignoreClusterUpdates: true,
    maxReconnectAttempts: 2,
    reconnectTimeWait: 1000,
    noAsyncTraces: true,
  };
  const authenticators: Authenticator[] = [];
  if (auth.creds) authenticators.push(credsAuthenticator(enc.encode(auth.creds)));
  else if (auth.nkeySeed) authenticators.push(nkeyAuthenticator(enc.encode(auth.nkeySeed)));
  if (authenticators.length) opts.authenticator = authenticators;
  if (auth.token) opts.token = auth.token;
  else if (auth.user) {
    opts.user = auth.user;
    opts.pass = auth.pass ?? "";
  } else if (fromUrl && !authenticators.length) {
    // `nats://token@host` carries a token; `nats://user:pass@host` a user.
    if (fromUrl.pass === undefined) opts.token = fromUrl.user!;
    else {
      opts.user = fromUrl.user!;
      opts.pass = fromUrl.pass;
    }
  }
  const wantsTls = servers.some((s) => s.tls) || !!auth.cert || !!auth.key;
  if (withTls && (wantsTls || auth.ca || auth.servername)) {
    const tls: Record<string, string> = {};
    if (auth.ca) tls["ca"] = auth.ca;
    if (auth.cert) tls["cert"] = auth.cert;
    if (auth.key) tls["key"] = auth.key;
    // Passed through to node:tls; nats.js otherwise names the dialled host.
    if (auth.servername) tls["servername"] = auth.servername;
    opts.tls = tls;
  }
  return opts;
}

/** True when the only TLS material is a CA or server name, so plain TCP is still allowed. */
function tlsIsOptional(connectionString: string, auth: NatsAuth): boolean {
  return !parseServers(connectionString).some((s) => s.tls) && !auth.cert && !auth.key;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function describeFailure(err: unknown, connectionString: string): Error {
  const msg = message(err);
  const where = (() => {
    try {
      return describeServers(connectionString);
    } catch {
      return "";
    }
  })();
  if (/authorization violation|authentication|user authentication expired/i.test(msg))
    return new Error(
      `NATS rejected the credentials${where ? ` at ${where}` : ""}. Check the user and password, token, NKey seed or .creds file on this account.`,
    );
  if (
    /connection refused|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timeout|TIMEOUT/i.test(msg) &&
    /connect/i.test(msg)
  )
    return new Error(
      `Cannot connect to NATS${where ? ` at ${where}` : ""}. Check that the client port (4222) is reachable; for a server on a private network, add an SSH tunnel to this account.`,
    );
  if (/ENOTFOUND|getaddrinfo/i.test(msg))
    return new Error(
      `Cannot resolve the NATS host${where ? ` (${where})` : ""}. Check the server URL.`,
    );
  if (/jetstream not enabled|503|no responders/i.test(msg) && /jetstream|\$JS/i.test(msg))
    return new Error("JetStream is not enabled for this account or server.");
  if (/self.signed|unable to verify|certificate/i.test(msg))
    return new Error(
      `NATS TLS verification failed: ${msg}. Add the server's CA under CA Certificate, or set the TLS server name when connecting through a tunnel.`,
    );
  if (/permissions violation/i.test(msg))
    return new Error(`NATS denied the operation for this user: ${msg}`);
  return err instanceof Error ? err : new Error(msg);
}

// ---------------------------------------------------------------------------
// Pool: one connection per server list + auth, closed after a minute idle
// ---------------------------------------------------------------------------

interface Entry {
  nc: Promise<NatsConnection>;
  timer: ReturnType<typeof setTimeout> | null;
}

const pool = new Map<string, Entry>();

async function open(connectionString: string, auth: NatsAuth): Promise<NatsConnection> {
  try {
    return await connect(buildConnectOptions(connectionString, auth));
  } catch (err) {
    // A CA entered for the monitoring endpoint must not force TLS on a
    // client port that has none.
    if (/does not support 'tls'/i.test(message(err)) && tlsIsOptional(connectionString, auth))
      return connect(buildConnectOptions(connectionString, auth, false));
    throw err;
  }
}

function acquire(key: string, connectionString: string, auth: NatsAuth): Entry {
  const existing = pool.get(key);
  if (existing) {
    if (existing.timer) clearTimeout(existing.timer);
    existing.timer = null;
    return existing;
  }
  const entry: Entry = {
    nc: open(connectionString, auth).catch((err: unknown) => {
      pool.delete(key);
      throw err;
    }),
    timer: null,
  };
  pool.set(key, entry);
  return entry;
}

function release(key: string): void {
  const entry = pool.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => drop(key), IDLE_TIMEOUT_MS);
  // Do not keep a CLI or test process alive for an idle connection.
  (entry.timer as { unref?: () => void }).unref?.();
}

function drop(key: string): void {
  const entry = pool.get(key);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pool.delete(key);
  void entry.nc.then((nc) => nc.close()).catch(() => {});
}

function isStale(err: unknown): boolean {
  return /connection closed|closed connection|disconnect|ECONNRESET|EPIPE|stale/i.test(
    message(err),
  );
}

/** Close every pooled connection. For tests and process shutdown. */
export async function closeAll(): Promise<void> {
  const keys = [...pool.keys()];
  for (const k of keys) drop(k);
}

// ---------------------------------------------------------------------------
// Value encoding
// ---------------------------------------------------------------------------

const strictDecoder = new TextDecoder("utf-8", { fatal: true });

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeData(bytes: Uint8Array): { data: string; encoding: "utf8" | "base64" } {
  try {
    return { data: strictDecoder.decode(bytes), encoding: "utf8" };
  } catch {
    return { data: toBase64(bytes), encoding: "base64" };
  }
}

function headersToRecord(h: MsgHdrs | undefined): Record<string, string> | undefined {
  if (!h) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of h) out[k] = v.join(", ");
  return Object.keys(out).length ? out : undefined;
}

function buildHeaders(json: string | undefined): MsgHdrs | undefined {
  if (!json) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("NATS driver: headers must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const h = natsHeaders();
  let any = false;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!k.trim()) continue;
    h.append(k.trim(), String(v ?? ""));
    any = true;
  }
  return any ? h : undefined;
}

function storedView(m: StoredMsg) {
  return {
    seq: m.seq,
    subject: m.subject,
    time: m.time.toISOString(),
    size: m.data.length,
    ...(headersToRecord(m.header) ? { headers: headersToRecord(m.header) } : {}),
    ...encodeData(m.data),
  };
}

function entryView(e: KvEntry) {
  return {
    key: e.key,
    revision: e.revision,
    operation: e.operation,
    created: e.created.toISOString(),
    size: e.length,
    ...(e.operation === "PUT" ? encodeData(e.value) : {}),
  };
}

function json<T>(raw: string | undefined, what: string): T {
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`NATS driver: ${what} is not valid JSON`);
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`NATS driver: ${what} is required`);
  return v;
}

function seqOf(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error("NATS driver: a sequence number is required");
  return n;
}

async function collect<T>(it: AsyncIterable<T>, max = MAX_LIST): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) {
    out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface MessagesOpts {
  /** Sequence to start at (inclusive). */
  cursor?: number;
  /** Subject filter; switches the walk to oldest first via `next_by_subj`. */
  subject?: string;
  limit?: number;
}

/**
 * A page of a stream's messages. Without a subject the walk runs newest
 * first from `last_seq`, skipping deleted sequences; with one, it runs
 * forward with `next_by_subj` (the server's own subject index).
 */
async function listMessages(jsm: JetStreamManager, stream: string, o: MessagesOpts) {
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
  const info = await jsm.streams.info(stream);
  const first = info.state.first_seq;
  const last = info.state.last_seq;
  const items: Array<{ seq: number; subject: string; time: string; size: number }> = [];
  if (info.state.messages === 0) return { items };
  if (o.subject) {
    let seq = Math.max(o.cursor ?? first, first);
    while (items.length < limit && seq <= last) {
      const m = await jsm.streams.getMessage(stream, {
        seq,
        next_by_subj: o.subject,
      } as unknown as { seq: number });
      if (!m) break;
      items.push({
        seq: m.seq,
        subject: m.subject,
        time: m.time.toISOString(),
        size: m.data.length,
      });
      seq = m.seq + 1;
    }
    return { items, ...(items.length === limit && seq <= last ? { nextCursor: seq } : {}) };
  }
  let seq = Math.min(o.cursor ?? last, last);
  let budget = limit * 4;
  while (items.length < limit && seq >= first && budget-- > 0) {
    const m = await jsm.streams.getMessage(stream, { seq });
    if (m)
      items.push({
        seq: m.seq,
        subject: m.subject,
        time: m.time.toISOString(),
        size: m.data.length,
      });
    seq--;
  }
  return { items, ...(seq >= first ? { nextCursor: seq } : {}) };
}

async function run(nc: NatsConnection, cmd: string, a: string[]): Promise<unknown> {
  const jsm = () => jetstreamManager(nc, { timeout: REQUEST_TIMEOUT_MS, checkAPI: false });
  switch (cmd) {
    case "info": {
      const [account, js] = await Promise.all([
        // The account these credentials land in (nats-server 2.10+).
        nc.request("$SYS.REQ.USER.INFO", undefined, { timeout: 2000 }).then(
          (m) => m.json<{ data?: { account?: string } }>().data?.account,
          () => undefined,
        ),
        jsm()
          .then((m) => m.getAccountInfo())
          .catch((err: unknown) => ({ error: message(err) })),
      ]);
      return { server: nc.info ?? null, ...(account ? { account } : {}), jetstream: js };
    }

    case "streams":
      return collect((await jsm()).streams.list());
    case "stream":
      return (await jsm()).streams.info(need(a[0], "stream name"));
    case "stream-add":
      return (await jsm()).streams.add(json<StreamConfig>(a[0], "stream configuration"));
    case "stream-update":
      return (await jsm()).streams.update(
        need(a[0], "stream name"),
        json<Partial<StreamConfig>>(a[1], "stream configuration"),
      );
    case "stream-purge": {
      const opts = a[1] ? json<PurgeOpts>(a[1], "purge options") : undefined;
      const r = await (await jsm()).streams.purge(need(a[0], "stream name"), opts);
      return { purged: r.purged };
    }
    case "stream-delete":
      return { ok: await (await jsm()).streams.delete(need(a[0], "stream name")) };

    case "messages":
      return listMessages(
        await jsm(),
        need(a[0], "stream name"),
        json<MessagesOpts>(a[1], "options"),
      );
    case "message": {
      const m = await (
        await jsm()
      ).streams.getMessage(need(a[0], "stream name"), {
        seq: seqOf(a[1]),
      });
      return m ? storedView(m) : null;
    }
    case "message-delete":
      return {
        ok: await (
          await jsm()
        ).streams.deleteMessage(
          need(a[0], "stream name"),
          seqOf(a[1]),
          a[2] === "1" || a[2] === "true",
        ),
      };

    case "consumers":
      return collect((await jsm()).consumers.list(need(a[0], "stream name")));
    case "consumer":
      return (await jsm()).consumers.info(need(a[0], "stream name"), need(a[1], "consumer name"));
    case "consumer-add":
      return (await jsm()).consumers.add(
        need(a[0], "stream name"),
        json<Partial<ConsumerConfig>>(a[1], "consumer configuration"),
      );
    case "consumer-update":
      return (await jsm()).consumers.update(
        need(a[0], "stream name"),
        need(a[1], "consumer name"),
        json<Partial<ConsumerConfig>>(a[2], "consumer configuration"),
      );
    case "consumer-delete":
      return {
        ok: await (
          await jsm()
        ).consumers.delete(need(a[0], "stream name"), need(a[1], "consumer name")),
      };
    case "consumer-pause": {
      const until = a[2] ? new Date(a[2]) : undefined;
      if (until && Number.isNaN(until.getTime()))
        throw new Error("NATS driver: the pause end time is not a date");
      return (await jsm()).consumers.pause(
        need(a[0], "stream name"),
        need(a[1], "consumer name"),
        until,
      );
    }
    case "consumer-resume":
      return (await jsm()).consumers.resume(need(a[0], "stream name"), need(a[1], "consumer name"));

    case "kv-create": {
      const bucket = need(a[0], "bucket name");
      await new Kvm(nc).create(bucket, json<Partial<KvOptions>>(a[1], "bucket options"));
      return (await jsm()).streams.info(`KV_${bucket}`);
    }
    case "kv-delete": {
      const kv = await new Kvm(nc).open(need(a[0], "bucket name"));
      return { ok: await kv.destroy() };
    }
    case "kv-keys": {
      const kv = await new Kvm(nc).open(need(a[0], "bucket name"));
      const limit = Math.min(Number(a[2]) || MAX_LIST, 10_000);
      const keys = await collect(await kv.keys(a[1] || ">"), limit);
      return keys.sort();
    }
    case "kv-get": {
      const kv = await new Kvm(nc).open(need(a[0], "bucket name"));
      const revision = a[2] ? Number(a[2]) : 0;
      const e = await kv.get(need(a[1], "key"), revision > 0 ? { revision } : undefined);
      return e ? entryView(e) : null;
    }
    case "kv-put": {
      const kv = await new Kvm(nc).open(need(a[0], "bucket name"));
      return { revision: await kv.put(need(a[1], "key"), enc.encode(a[2] ?? "")) };
    }
    case "kv-del": {
      const kv = await new Kvm(nc).open(need(a[0], "bucket name"));
      const key = need(a[1], "key");
      if (a[2] === "1" || a[2] === "true") await kv.purge(key);
      else await kv.delete(key);
      return { ok: true };
    }
    case "kv-history": {
      const kv = await new Kvm(nc).open(need(a[0], "bucket name"));
      const limit = Math.min(Number(a[2]) || 100, 1000);
      const it = await kv.history(a[1] ? { key: a[1] } : {});
      const all = await collect(it, 5000);
      return all.slice(-limit).reverse().map(entryView);
    }

    case "obj-create": {
      const bucket = need(a[0], "bucket name");
      await new Objm(nc).create(bucket, json<Partial<ObjectStoreOptions>>(a[1], "store options"));
      return (await jsm()).streams.info(`OBJ_${bucket}`);
    }
    case "obj-delete": {
      const os = await new Objm(nc).open(need(a[0], "bucket name"));
      return { ok: await os.destroy() };
    }
    case "obj-list": {
      const os = await new Objm(nc).open(need(a[0], "bucket name"));
      return (await os.list()).filter((o) => !o.deleted).map(objectView);
    }
    case "obj-info": {
      const os = await new Objm(nc).open(need(a[0], "bucket name"));
      const info = await os.info(need(a[1], "object name"));
      return info && !info.deleted ? objectView(info) : null;
    }
    case "obj-get": {
      const os = await new Objm(nc).open(need(a[0], "bucket name"));
      const name = need(a[1], "object name");
      const info = await os.info(name);
      if (!info || info.deleted) return null;
      const max = Math.min(Number(a[2]) || MAX_OBJECT_PREVIEW, MAX_OBJECT_PREVIEW);
      if (info.size > max) return { info: objectView(info), truncated: true };
      const blob = await os.getBlob(name);
      return { info: objectView(info), truncated: false, ...(blob ? encodeData(blob) : {}) };
    }
    case "obj-put": {
      const os = await new Objm(nc).open(need(a[0], "bucket name"));
      const info = await os.putBlob(
        { name: need(a[1], "object name"), ...(a[3] ? { description: a[3] } : {}) },
        fromBase64(a[2] ?? ""),
      );
      return objectView(info);
    }
    case "obj-remove": {
      const os = await new Objm(nc).open(need(a[0], "bucket name"));
      await os.delete(need(a[1], "object name"));
      return { ok: true };
    }

    case "publish": {
      const subject = need(a[0], "subject");
      const data = enc.encode(a[1] ?? "");
      const headers = buildHeaders(a[2]);
      const mode = a[3] || "core";
      const timeout = Math.min(Math.max(Number(a[4]) || 5000, 100), 60_000);
      if (mode === "request") {
        const reply = await nc.request(subject, data, { timeout, ...(headers ? { headers } : {}) });
        return {
          reply: encodeData(reply.data),
          ...(headersToRecord(reply.headers) ? { headers: headersToRecord(reply.headers) } : {}),
        };
      }
      if (mode === "jetstream") {
        const ack = await jetstream(nc, { timeout }).publish(subject, data, {
          ...(headers ? { headers } : {}),
          ...(a[5] ? { msgID: a[5] } : {}),
        });
        return { stream: ack.stream, seq: ack.seq, duplicate: ack.duplicate };
      }
      nc.publish(subject, data, headers ? { headers } : undefined);
      await nc.flush();
      return { ok: true };
    }

    default:
      throw new Error(`NATS driver: unknown command "${cmd}"`);
  }
}

function objectView(o: {
  name: string;
  description?: string;
  size: number;
  chunks: number;
  digest: string;
  mtime: string;
  headers?: MsgHdrs;
  options?: { link?: unknown };
}) {
  return {
    name: o.name,
    ...(o.description ? { description: o.description } : {}),
    size: o.size,
    chunks: o.chunks,
    digest: o.digest,
    mtime: o.mtime,
    ...(o.options?.link ? { link: true } : {}),
    ...(headersToRecord(o.headers) ? { headers: headersToRecord(o.headers) } : {}),
  };
}

export function dialTargets(connectionString: string): DialTarget[] {
  return natsDialTargets(connectionString);
}

export const driver = {
  id: "nats",
  dialTargets,

  async command(
    connectionString: string,
    cmd: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const { auth, rest, keyed } = decodeAuthArgs(args);
    const key = `${connectionString}\n${keyed}`;
    for (let attempt = 0; ; attempt++) {
      const entry = acquire(key, connectionString, auth);
      try {
        const nc = await entry.nc;
        if (nc.isClosed()) throw new Error("connection closed");
        return await run(nc, cmd, rest);
      } catch (err) {
        if (attempt === 0 && isStale(err)) {
          drop(key);
          continue;
        }
        throw describeFailure(err, connectionString);
      } finally {
        release(key);
      }
    }
  },
} satisfies KvNodeDriver;
