import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  KvHostServices,
  KvListResult,
  MetricSeries,
  PluginClient,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightResult,
  PublishMessagePayload,
  PublishMessageResult,
  QuotaUsage,
  ResourceInstance,
  SidebarItemSchema,
  StorageObject,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf } from "@infrawrench/plugin-base";
import type { NatsContext } from "./api.js";
import { buildContext, joinId, NatsApiError, natsFetch, splitId, statusOf } from "./api.js";
import { authFromCredentials, encodeAuth, parseServers } from "./connection.js";
import {
  bucketName,
  bucketStreamUpdate,
  consumerConfigFromFields,
  consumerCreateFields,
  kvCreateFields,
  kvOptionsFromFields,
  objCreateFields,
  objOptionsFromFields,
  streamConfigFromFields,
  streamCreateFields,
} from "./jetstream.js";
import type { AccStat, Conn, JsConsumer, JsStream, Jsz, Varz } from "./mappers.js";
import {
  instance,
  mapAccount,
  mapConnection,
  mapConsumer,
  mapKvBucket,
  mapObjectStore,
  mapServer,
  mapStream,
} from "./mappers.js";
import { COMMANDS, renderNatsDetail, renderNatsSidebar } from "./render.js";

const MAX_CONNECTIONS = 1024;
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const HISTORY_ROWS = 50;
const JSZ_QUERY = {
  accounts: true,
  streams: true,
  consumers: true,
  config: true,
  limit: 1024,
} as const;

/** The default account a server without accounts configured puts every user in. */
const GLOBAL_ACCOUNT = "$G";

const PROBES: Array<{ capability: PreflightCapability; path?: string }> = [
  {
    capability: {
      id: "varz",
      label: "Server information",
      description:
        "Read /varz on the monitoring endpoint: version, connections, traffic and limits.",
      requiredPermissions: [
        { id: "http_port", label: "Monitoring port enabled (http_port / -m 8222)" },
      ],
    },
    path: "/varz",
  },
  {
    capability: {
      id: "jsz",
      label: "JetStream monitoring",
      description: "Read /jsz: accounts, streams and consumers.",
      requiredPermissions: [{ id: "jetstream", label: "JetStream enabled on this server" }],
    },
    path: "/jsz",
  },
  {
    capability: {
      id: "accounts",
      label: "Accounts",
      description: "Read /accountz and /accstatz.",
      requiredPermissions: [{ id: "accounts", label: "nats-server 2.2 or later" }],
    },
    path: "/accstatz",
  },
  {
    capability: {
      id: "client",
      label: "Client connection",
      description:
        "Connect to the client port with the account's credentials: needed to publish and to create, edit and delete streams, consumers, buckets and object stores.",
      requiredPermissions: [
        { id: "servers", label: "Server URL set (nats://host:4222)" },
        { id: "auth", label: "Credentials the server accepts" },
      ],
    },
  },
  {
    capability: {
      id: "jetstream",
      label: "JetStream management",
      description: "Call the JetStream API ($JS.API.>) as this user.",
      requiredPermissions: [
        { id: "jetstream", label: "JetStream enabled for the user's account" },
        { id: "js-api", label: "Publish and subscribe permission on $JS.API.> and _INBOX.>" },
      ],
    },
  },
];

export const NATS_PREFLIGHT = { capabilities: PROBES.map((p) => p.capability) };

interface PeerRow {
  rid?: number;
  remote_id?: string;
  remote_name?: string;
  name?: string;
  ip?: string;
  port?: number;
  rtt?: string;
  in_msgs?: number;
  out_msgs?: number;
  subscriptions?: number;
  did_solicit?: boolean;
  is_configured?: boolean;
  account?: string;
}

/** `info` from the driver: the INFO block, the user's account and its JetStream usage. */
interface DriverInfo {
  server: {
    server_id?: string;
    server_name?: string;
    version?: string;
    go?: string;
    host?: string;
    port?: number;
    max_payload?: number;
    tls_required?: boolean;
    auth_required?: boolean;
    jetstream?: boolean;
    cluster?: string;
  } | null;
  account?: string;
  jetstream?: {
    memory?: number;
    storage?: number;
    streams?: number;
    consumers?: number;
    limits?: { max_memory?: number; max_storage?: number };
    error?: string;
  };
}

interface MessageView {
  seq: number;
  subject: string;
  time: string;
  size: number;
  headers?: Record<string, string>;
  data?: string;
  encoding?: "utf8" | "base64";
}

interface KvEntryView {
  key: string;
  revision: number;
  operation: string;
  created: string;
  size: number;
  data?: string;
  encoding?: "utf8" | "base64";
}

interface ObjectView {
  name: string;
  description?: string;
  size: number;
  chunks: number;
  digest: string;
  mtime: string;
  link?: boolean;
}

/** Streams grouped by account, from the driver or from /jsz. */
interface StreamSet {
  account: string;
  streams: JsStream[];
  /** `jsz` sets carry their consumers inline; `api` sets list them per stream. */
  source: "api" | "jsz";
}

const TYPE_OF_ID = /:(nats-[a-z-]+):/;

export class NatsClient implements PluginClient {
  private readonly ctx: NatsContext | undefined;
  private readonly servers: string;
  private readonly authArg: string;
  private readonly kvHost: KvHostServices | undefined;
  private infoPromise: Promise<DriverInfo> | undefined;
  private streamsCache: { at: number; p: Promise<StreamSet[]> } | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const url = (credentials["url"] ?? "").trim();
    this.servers = (credentials["servers"] ?? "").trim();
    if (!url && !this.servers)
      throw new Error("NATS plugin: add a server URL (nats://host:4222) or the monitoring URL");
    this.ctx = url ? buildContext(credentials, services?.http) : undefined;
    this.authArg = encodeAuth(authFromCredentials(credentials));
    this.kvHost = services?.kv;
  }

  /** True when the account can reach the client port: publish and JetStream writes. */
  private get writable(): boolean {
    return !!this.servers && !!this.kvHost;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private get<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T> {
    if (!this.ctx)
      return Promise.reject(
        new NatsApiError(
          400,
          "NATS plugin: this view reads the monitoring endpoint; add the monitoring URL (http://host:8222) to the account",
        ),
      );
    return natsFetch<T>(this.ctx, path, query);
  }

  private soft<T>(p: Promise<T>): Promise<T | undefined> {
    return p.catch(() => undefined);
  }

  /** One driver command, with the account's auth prepended. */
  private async js<T>(cmd: string, ...args: (string | number)[]): Promise<T> {
    if (!this.servers)
      throw new NatsApiError(
        400,
        "NATS plugin: add the server URL (nats://host:4222) to this account to publish and to manage JetStream",
      );
    if (!this.kvHost)
      throw new NatsApiError(501, "NATS plugin: this host cannot open NATS client connections");
    return (await this.kvHost.command(cmd, this.authArg, ...args)) as T;
  }

  private info(): Promise<DriverInfo> {
    if (!this.infoPromise) {
      this.infoPromise = this.js<DriverInfo>("info");
      this.infoPromise.catch(() => {
        this.infoPromise = undefined;
      });
    }
    return this.infoPromise;
  }

  /** The account the configured credentials land in. */
  private async account(): Promise<string> {
    return (await this.info()).account || GLOBAL_ACCOUNT;
  }

  /**
   * Writes go to the account the credentials land in; refuse one aimed at a
   * stream the monitoring endpoint showed in another account.
   */
  private async assertAccount(account: string): Promise<void> {
    const mine = (await this.info()).account;
    if (mine && account && account !== mine)
      throw new NatsApiError(
        400,
        `NATS plugin: this is in account "${account}", but the account's credentials connect to "${mine}"`,
      );
  }

  /** `/jsz` answers an error body (or nothing useful) when JetStream is off; read that as no streams. */
  private jsz(): Promise<Jsz | undefined> {
    return this.ctx ? this.soft(this.get<Jsz>("/jsz", JSZ_QUERY)) : Promise.resolve(undefined);
  }

  /**
   * Every stream, from the JetStream API when the account has a server URL
   * (current in a cluster, and the only source without monitoring), else
   * from `/jsz`. Memoised briefly: one sync lists four types off it.
   */
  private streamSets(): Promise<StreamSet[]> {
    const now = Date.now();
    if (this.streamsCache && now - this.streamsCache.at < 3000) return this.streamsCache.p;
    const fromJsz = () =>
      this.jsz().then((js) =>
        (js?.account_details ?? []).map((a): StreamSet => ({
          account: a.name ?? a.id ?? "",
          streams: a.stream_detail ?? [],
          source: "jsz",
        })),
      );
    const p: Promise<StreamSet[]> = this.writable
      ? Promise.all([this.account(), this.js<JsStream[]>("streams")])
          .then(([account, streams]): StreamSet[] => [{ account, streams, source: "api" }])
          // With a monitoring URL as well, a client port that is down still
          // leaves the read-only view; writes report the real error.
          .catch((err: unknown) => (this.ctx ? fromJsz() : Promise.reject(err)))
      : fromJsz();
    this.streamsCache = { at: now, p };
    p.catch(() => {
      this.streamsCache = undefined;
    });
    return p;
  }

  private async health(): Promise<string> {
    try {
      const h = await this.get<{ status?: string; error?: string }>("/healthz");
      return h.status ?? "ok";
    } catch (err) {
      return err instanceof Error ? err.message.replace(/^.*?: /, "") : "unavailable";
    }
  }

  private async server(accountId: string): Promise<ResourceInstance> {
    if (!this.ctx) return this.serverFromInfo(accountId);
    const [varz, js, health] = await Promise.all([
      this.get<Varz>("/varz"),
      this.jsz(),
      this.health(),
    ]);
    const r = mapServer(accountId, this.ctx.baseUrl, varz, js, health);
    if (this.servers) {
      const first = parseServers(this.servers)[0];
      if (first)
        r.resolvedOutputs["clientUrl"] = `${first.tls ? "tls" : "nats"}://${first.hostPort}`;
    }
    return r;
  }

  /** The server from the client connection's INFO, for an account without a monitoring URL. */
  private async serverFromInfo(accountId: string): Promise<ResourceInstance> {
    const info = await this.info();
    const s = info.server ?? {};
    const js = info.jetstream;
    const first = parseServers(this.servers)[0];
    const clientUrl = first ? `${first.tls ? "tls" : "nats"}://${first.hostPort}` : "";
    const r = instance(
      accountId,
      "nats-server",
      "server",
      s.server_name || first?.host || "nats-server",
      {
        serverName: s.server_name,
        serverId: s.server_id,
        version: s.version,
        goVersion: s.go,
        clientUrl,
        cluster: s.cluster,
        health: "ok",
        maxPayload: s.max_payload,
        tlsRequired: s.tls_required,
        authRequired: s.auth_required,
        jetstream: !!s.jetstream,
        jsStorage: js && !js.error ? js.storage : undefined,
        jsMaxStorage:
          js?.limits?.max_storage && js.limits.max_storage > 0 ? js.limits.max_storage : undefined,
        jsMemory: js && !js.error ? js.memory : undefined,
        jsMaxMemory:
          js?.limits?.max_memory && js.limits.max_memory > 0 ? js.limits.max_memory : undefined,
        jsStreams: js?.streams,
        jsConsumers: js?.consumers,
      },
    );
    r.resolvedOutputs = clientUrl ? { clientUrl } : {};
    return r;
  }

  private async peers(accountId: string): Promise<ResourceInstance[]> {
    if (!this.ctx) return [];
    const [routez, gatewayz, leafz] = await Promise.all([
      this.soft(this.get<{ routes?: PeerRow[] | null }>("/routez")),
      this.soft(
        this.get<{
          outbound_gateways?: Record<string, { connection?: PeerRow }>;
          inbound_gateways?: Record<string, Array<{ connection?: PeerRow }>>;
        }>("/gatewayz"),
      ),
      this.soft(this.get<{ leafs?: PeerRow[] | null }>("/leafz")),
    ]);
    const out: ResourceInstance[] = [];
    const add = (
      kind: string,
      key: string,
      name: string,
      p: PeerRow | undefined,
      solicited?: boolean,
    ) =>
      out.push(
        instance(accountId, "nats-peer", joinId(kind, key), `${kind} ${name}`, {
          kind,
          name,
          address: p?.ip ? `${p.ip}:${p.port ?? ""}` : undefined,
          account: p?.account,
          rtt: p?.rtt,
          inMsgs: p?.in_msgs,
          outMsgs: p?.out_msgs,
          subscriptions: p?.subscriptions,
          solicited: solicited ?? p?.did_solicit,
        }),
      );
    for (const r of routez?.routes ?? [])
      add(
        "route",
        String(r.rid ?? r.remote_id ?? ""),
        r.remote_name || r.remote_id || String(r.rid ?? ""),
        r,
      );
    for (const [name, g] of Object.entries(gatewayz?.outbound_gateways ?? {}))
      add("gateway", `out-${name}`, name, g.connection, true);
    for (const [name, list] of Object.entries(gatewayz?.inbound_gateways ?? {}))
      list.forEach((g, i) => add("gateway", `in-${name}-${i}`, name, g.connection, false));
    for (const l of leafz?.leafs ?? [])
      add("leaf", `${l.name ?? ""}-${l.ip ?? ""}-${l.port ?? ""}`, l.name || l.ip || "leaf", l);
    return out;
  }

  private async accounts(accountId: string): Promise<ResourceInstance[]> {
    if (!this.ctx) {
      const [account, info] = await Promise.all([this.account(), this.info()]);
      const js = info.jetstream && !info.jetstream.error ? info.jetstream : undefined;
      return [
        instance(accountId, "nats-account", joinId(account), account, {
          name: account,
          jsStorage: js?.storage,
          jsMemory: js?.memory,
          streams: js?.streams,
          consumers: js?.consumers,
        }),
      ];
    }
    const [accountz, accstatz, js] = await Promise.all([
      this.soft(this.get<{ accounts?: string[]; system_account?: string }>("/accountz")),
      this.soft(this.get<{ account_statz?: AccStat[] }>("/accstatz", { unused: true })),
      this.jsz(),
    ]);
    const stats = new Map((accstatz?.account_statz ?? []).map((a) => [a.acc ?? a.name ?? "", a]));
    const jsAcc = new Map((js?.account_details ?? []).map((a) => [a.name ?? a.id ?? "", a]));
    const names = new Set<string>([
      ...(accountz?.accounts ?? []),
      ...stats.keys(),
      ...jsAcc.keys(),
    ]);
    if (!accountz && !accstatz && !js) await this.get("/accountz");
    return [...names]
      .filter(Boolean)
      .sort()
      .map((n) => mapAccount(accountId, n, stats.get(n), jsAcc.get(n), accountz?.system_account));
  }

  private async consumers(accountId: string): Promise<ResourceInstance[]> {
    const sets = await this.streamSets();
    if (sets.every((x) => x.source === "jsz"))
      return sets.flatMap(({ account, streams }) =>
        streams.flatMap((st) =>
          (st.consumer_detail ?? []).map((c) =>
            mapConsumer(accountId, account, { ...c, stream_name: c.stream_name ?? st.name ?? "" }),
          ),
        ),
      );
    const out = await Promise.all(
      sets.flatMap(({ account, streams }) =>
        streams.map(async (st) => {
          const name = st.name ?? String(st.config?.["name"] ?? "");
          const list = await this.js<JsConsumer[]>("consumers", name);
          return list.map((c) =>
            mapConsumer(accountId, account, { ...c, stream_name: c.stream_name ?? name }),
          );
        }),
      ),
    );
    return out.flat();
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "nats-server":
        return [await this.server(accountId)];
      case "nats-peer":
        return this.peers(accountId);
      case "nats-account":
        return this.accounts(accountId);
      case "nats-stream":
        return (await this.streamSets()).flatMap(({ account, streams }) =>
          streams.map((st) => mapStream(accountId, account, st)),
        );
      case "nats-kv-bucket":
        return (await this.streamSets()).flatMap(({ account, streams }) =>
          streams
            .filter((st) => (st.name ?? "").startsWith("KV_"))
            .map((st) => mapKvBucket(accountId, account, st)),
        );
      case "nats-object-store":
        return (await this.streamSets()).flatMap(({ account, streams }) =>
          streams
            .filter((st) => (st.name ?? "").startsWith("OBJ_"))
            .map((st) => mapObjectStore(accountId, account, st)),
        );
      case "nats-consumer":
        return this.consumers(accountId);
      case "nats-connection": {
        if (!this.ctx) return [];
        const res = await this.get<{ connections?: Conn[] | null }>("/connz", {
          auth: true,
          limit: MAX_CONNECTIONS,
          sort: "msgs_to",
        });
        return (res.connections ?? []).map((c) => mapConnection(accountId, c));
      }
      default:
        return [];
    }
  }

  /** A stream (by its own name) from the driver, or from `/jsz` for that account. */
  private async streamInfo(account: string, stream: string): Promise<JsStream | undefined> {
    if (this.writable) return this.js<JsStream>("stream", stream);
    const js = await this.get<Jsz>("/jsz", { ...JSZ_QUERY, acc: account });
    for (const a of js.account_details ?? [])
      for (const st of a.stream_detail ?? []) if (st.name === stream) return st;
    return undefined;
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "nats-server":
        return this.server(accountId);
      case "nats-connection": {
        const res = await this.get<{ connections?: Conn[] | null }>("/connz", {
          cid: id,
          auth: true,
          state: "any",
        });
        const c = res.connections?.[0];
        if (!c) throw new NatsApiError(404, "NATS plugin: the connection is closed");
        return mapConnection(accountId, c);
      }
      case "nats-stream": {
        const [account, name] = splitId(id, 2);
        const st = await this.streamInfo(account!, name!);
        if (!st) throw new NatsApiError(404, "NATS plugin: stream not found on this server");
        return mapStream(accountId, account!, st);
      }
      case "nats-kv-bucket": {
        const [account, bucket] = splitId(id, 2);
        const st = await this.streamInfo(account!, `KV_${bucket}`);
        if (!st) throw new NatsApiError(404, "NATS plugin: bucket not found on this server");
        const r = mapKvBucket(accountId, account!, st);
        r.resolvedOutputs = { bucket: bucket! };
        if (this.writable) {
          const history = await this.soft(
            this.js<KvEntryView[]>("kv-history", bucket!, "", HISTORY_ROWS),
          );
          if (history) r.resolvedOutputs["history"] = JSON.stringify(stripData(history));
        }
        return r;
      }
      case "nats-object-store": {
        const [account, bucket] = splitId(id, 2);
        const st = await this.streamInfo(account!, `OBJ_${bucket}`);
        if (!st) throw new NatsApiError(404, "NATS plugin: object store not found on this server");
        const r = mapObjectStore(accountId, account!, st);
        r.resolvedOutputs = { bucket: bucket! };
        if (this.writable) {
          const objects = await this.soft(this.js<ObjectView[]>("obj-list", bucket!));
          if (objects) {
            r.fields["objects"] = objects.length;
            r.resolvedOutputs["objects"] = JSON.stringify(objects.slice(0, 200));
          }
        }
        return r;
      }
      case "nats-consumer": {
        const [account, stream, name] = splitId(id, 3);
        if (this.writable) {
          const c = await this.js<JsConsumer>("consumer", stream!, name!);
          return mapConsumer(accountId, account!, { ...c, stream_name: c.stream_name ?? stream! });
        }
        const st = await this.streamInfo(account!, stream!);
        const c = st?.consumer_detail?.find((x) => x.name === name);
        if (!c) throw new NatsApiError(404, "NATS plugin: consumer not found on this server");
        return mapConsumer(accountId, account!, { ...c, stream_name: c.stream_name ?? stream! });
      }
      default: {
        const found = (await this.listResources(typeId, accountId)).find(
          (r) => r.externalId === id,
        );
        if (!found) throw new NatsApiError(404, `NATS plugin: ${typeId} "${id}" not found`);
        return found;
      }
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const r = await this.getResource(typeId, resourceId, accountId);
    return String(r.resolvedOutputs[outputKey] ?? r.fields[outputKey] ?? "");
  }

  // -------------------------------------------------------------------------
  // Create, edit, delete
  // -------------------------------------------------------------------------

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "nats-stream":
        return { fields: streamCreateFields() };
      case "nats-kv-bucket":
        return { fields: kvCreateFields() };
      case "nats-object-store":
        return { fields: objCreateFields() };
      case "nats-consumer": {
        if (parentResourceId && TYPE_OF_ID.exec(parentResourceId)?.[1] === "nats-stream")
          return { fields: consumerCreateFields(undefined) };
        const streams = (await this.js<JsStream[]>("streams"))
          .map((s) => s.name ?? "")
          .filter((n) => n && !n.startsWith("KV_") && !n.startsWith("OBJ_"))
          .sort();
        if (streams.length === 0)
          throw new NatsApiError(
            400,
            "NATS plugin: create a stream first; a consumer reads from one",
          );
        return { fields: consumerCreateFields(streams) };
      }
      default:
        throw new NatsApiError(400, `NATS plugin: cannot create ${typeId}`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const account = await this.account();
    this.streamsCache = undefined;
    switch (typeId) {
      case "nats-stream": {
        const st = await this.js<JsStream>(
          "stream-add",
          JSON.stringify(streamConfigFromFields(fields)),
        );
        return mapStream(accountId, account, st);
      }
      case "nats-consumer": {
        let stream = (fields["stream"] ?? "").trim();
        if (parentResourceId) {
          const [parentAccount, parentStream] = splitId(externalIdOf(parentResourceId), 2);
          await this.assertAccount(parentAccount!);
          stream = parentStream!;
        }
        if (!stream) throw new NatsApiError(400, "NATS plugin: pick the stream the consumer reads");
        const c = await this.js<JsConsumer>(
          "consumer-add",
          stream,
          JSON.stringify(consumerConfigFromFields(fields)),
        );
        return mapConsumer(accountId, account, { ...c, stream_name: c.stream_name ?? stream });
      }
      case "nats-kv-bucket": {
        const name = bucketName(fields);
        const st = await this.js<JsStream>(
          "kv-create",
          name,
          JSON.stringify(kvOptionsFromFields(fields)),
        );
        return mapKvBucket(accountId, account, st);
      }
      case "nats-object-store": {
        const name = bucketName(fields);
        const st = await this.js<JsStream>(
          "obj-create",
          name,
          JSON.stringify(objOptionsFromFields(fields)),
        );
        return mapObjectStore(accountId, account, st);
      }
      default:
        throw new NatsApiError(400, `NATS plugin: cannot create ${typeId}`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    this.streamsCache = undefined;
    switch (typeId) {
      case "nats-stream": {
        const [account, name] = splitId(id, 2);
        await this.assertAccount(account!);
        const st = await this.js<JsStream>(
          "stream-update",
          name!,
          JSON.stringify(streamConfigFromFields(fields, true)),
        );
        return mapStream(accountId, account!, st);
      }
      case "nats-consumer": {
        const [account, stream, name] = splitId(id, 3);
        await this.assertAccount(account!);
        const c = await this.js<JsConsumer>(
          "consumer-update",
          stream!,
          name!,
          JSON.stringify(consumerConfigFromFields(fields, true)),
        );
        return mapConsumer(accountId, account!, { ...c, stream_name: c.stream_name ?? stream! });
      }
      case "nats-kv-bucket":
      case "nats-object-store": {
        const [account, bucket] = splitId(id, 2);
        await this.assertAccount(account!);
        const prefix = typeId === "nats-kv-bucket" ? "KV_" : "OBJ_";
        const st = await this.js<JsStream>(
          "stream-update",
          `${prefix}${bucket}`,
          JSON.stringify(bucketStreamUpdate(fields)),
        );
        return typeId === "nats-kv-bucket"
          ? mapKvBucket(accountId, account!, st)
          : mapObjectStore(accountId, account!, st);
      }
      default:
        throw new NatsApiError(400, `NATS plugin: ${typeId} cannot be edited`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    this.streamsCache = undefined;
    switch (typeId) {
      case "nats-stream": {
        const [account, name] = splitId(id, 2);
        await this.assertAccount(account!);
        await this.js("stream-delete", name!);
        return;
      }
      case "nats-consumer": {
        const [account, stream, name] = splitId(id, 3);
        await this.assertAccount(account!);
        await this.js("consumer-delete", stream!, name!);
        return;
      }
      case "nats-kv-bucket": {
        const [account, bucket] = splitId(id, 2);
        await this.assertAccount(account!);
        await this.js("kv-delete", bucket!);
        return;
      }
      case "nats-object-store": {
        const [account, bucket] = splitId(id, 2);
        await this.assertAccount(account!);
        await this.js("obj-delete", bucket!);
        return;
      }
      default:
        throw new NatsApiError(400, `NATS plugin: ${typeId} cannot be deleted`);
    }
  }

  /** The full JSON configuration of a stream or consumer, for the config editor. */
  async getManifest(resourceId: string, accountId: string): Promise<string> {
    const typeId = TYPE_OF_ID.exec(resourceId)?.[1] ?? "";
    if (typeId !== "nats-stream" && typeId !== "nats-consumer")
      throw new NatsApiError(
        400,
        "NATS plugin: only streams and consumers have a configuration editor",
      );
    const r = await this.getResource(typeId, resourceId, accountId);
    const cfg = r.resolvedOutputs["config"];
    if (!cfg) throw new NatsApiError(404, "NATS plugin: the server did not report a configuration");
    return JSON.stringify(JSON.parse(cfg), null, 2);
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const typeId = TYPE_OF_ID.exec(resourceId)?.[1] ?? "";
    const id = externalIdOf(resourceId);
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(manifest) as Record<string, unknown>;
    } catch {
      throw new NatsApiError(400, "NATS plugin: the configuration is not valid JSON");
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg))
      throw new NatsApiError(400, "NATS plugin: the configuration must be a JSON object");
    this.streamsCache = undefined;
    if (typeId === "nats-stream") {
      const [account, name] = splitId(id, 2);
      if (cfg["name"] !== undefined && cfg["name"] !== name)
        throw new NatsApiError(
          400,
          `NATS plugin: the name must stay ${name}; create a new stream instead`,
        );
      await this.assertAccount(account!);
      await this.js("stream-update", name!, JSON.stringify(cfg));
      return;
    }
    if (typeId === "nats-consumer") {
      const [account, stream, name] = splitId(id, 3);
      await this.assertAccount(account!);
      await this.js("consumer-update", stream!, name!, JSON.stringify(cfg));
      return;
    }
    throw new NatsApiError(
      400,
      "NATS plugin: only streams and consumers have a configuration editor",
    );
  }

  /** Header and row actions: purge a stream, resume a consumer, delete one message. */
  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    if (typeId === "nats-stream" && actionId === "purge") {
      const [account, name] = splitId(id, 2);
      await this.assertAccount(account!);
      await this.js("stream-purge", name!);
      return;
    }
    if (typeId === "nats-stream" && actionId.startsWith("delete-message:")) {
      const [account, name] = splitId(id, 2);
      await this.assertAccount(account!);
      await this.js("message-delete", name!, actionId.slice("delete-message:".length), "0");
      return;
    }
    if (typeId === "nats-consumer" && actionId === "resume") {
      const [account, stream, name] = splitId(id, 3);
      await this.assertAccount(account!);
      await this.js("consumer-resume", stream!, name!);
      return;
    }
    throw new NatsApiError(400, `NATS plugin: unknown action "${actionId}"`);
  }

  /** Form-driven actions: purge with a filter, delete by sequence, pause until a time. */
  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const v = decodePromptArgs(args);
    const id = externalIdOf(resourceId);
    if (typeId === "nats-stream" && command === COMMANDS.purge) {
      const [account, name] = splitId(id, 2);
      await this.assertAccount(account!);
      const opts: Record<string, unknown> = {};
      if ((v["subject"] ?? "").trim()) opts["filter"] = v["subject"]!.trim();
      if ((v["keep"] ?? "").trim()) opts["keep"] = Number(v["keep"]);
      else if ((v["seq"] ?? "").trim()) opts["seq"] = Number(v["seq"]);
      return this.js(
        "stream-purge",
        name!,
        ...(Object.keys(opts).length ? [JSON.stringify(opts)] : []),
      );
    }
    if (typeId === "nats-stream" && command === COMMANDS.deleteMessage) {
      const [account, name] = splitId(id, 2);
      await this.assertAccount(account!);
      const seq = (v["seq"] ?? "").trim();
      if (!/^\d+$/.test(seq)) throw new NatsApiError(400, "NATS plugin: enter a sequence number");
      return this.js("message-delete", name!, seq, v["erase"] === "true" ? "1" : "0");
    }
    if (typeId === "nats-consumer" && command === COMMANDS.pause) {
      const [account, stream, name] = splitId(id, 3);
      await this.assertAccount(account!);
      const until = (v["until"] ?? "").trim();
      if (!until) throw new NatsApiError(400, "NATS plugin: pick when the pause ends");
      return this.js("consumer-pause", stream!, name!, until);
    }
    throw new NatsApiError(400, `NATS plugin: unknown command "${command}"`);
  }

  // -------------------------------------------------------------------------
  // Publish (core NATS, JetStream, request/reply)
  // -------------------------------------------------------------------------

  async publishMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: PublishMessagePayload,
  ): Promise<PublishMessageResult> {
    const extra = (k: string) => {
      const v = payload.extras[k];
      return typeof v === "string" ? v.trim() : "";
    };
    const headers = payload.extras["headers"];
    const headersJson =
      headers && typeof headers === "object" && Object.keys(headers).some((k) => k.trim())
        ? JSON.stringify(headers)
        : "";
    const subject = extra("subject");
    if (!subject) throw new NatsApiError(400, "NATS plugin: enter a subject");
    if (/\s|[*>]/.test(subject))
      throw new NatsApiError(
        400,
        "NATS plugin: publish to a concrete subject, without spaces, * or >",
      );
    const mode = typeId === "nats-server" ? extra("mode") || "core" : "jetstream";
    if (!["core", "request", "jetstream"].includes(mode))
      throw new NatsApiError(400, `NATS plugin: unknown publish mode "${mode}"`);
    if (typeId !== "nats-server" && typeId !== "nats-stream")
      throw new NatsApiError(400, `NATS plugin: cannot publish from ${typeId}`);
    if (typeId === "nats-stream") {
      const [account] = splitId(externalIdOf(resourceId), 2);
      await this.assertAccount(account!);
    }
    const timeout = extra("timeoutMs") || "5000";
    const r = await this.js<{
      stream?: string;
      seq?: number;
      duplicate?: boolean;
      reply?: { data: string; encoding: string };
    }>("publish", subject, payload.body, headersJson, mode, timeout, extra("msgId"));
    if (mode === "request") {
      const text =
        r.reply?.encoding === "base64" ? `(binary, base64) ${r.reply.data}` : (r.reply?.data ?? "");
      return {
        summary: `Reply: ${text.length > 400 ? `${text.slice(0, 400)}…` : text || "(empty)"}`,
      };
    }
    if (mode === "jetstream")
      return {
        ...(r.seq !== undefined ? { id: `${r.stream ?? ""} #${r.seq}` } : {}),
        summary: r.duplicate
          ? `Duplicate of ${r.stream} message ${r.seq}; not stored again`
          : `Stored in ${r.stream} as message ${r.seq}`,
      };
    return { summary: `Published to ${subject}` };
  }

  // -------------------------------------------------------------------------
  // Key browser: KV bucket keys, and a stream's messages by sequence
  // -------------------------------------------------------------------------

  async listKvKeys(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    params: { prefix?: string; cursor?: string; limit?: number } = {},
  ): Promise<KvListResult> {
    const id = externalIdOf(resourceId);
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    if (resourceTypeId === "nats-kv-bucket") {
      const [, bucket] = splitId(id, 2);
      const prefix = params.prefix ?? "";
      // A prefix ending at a token boundary narrows on the server.
      const filter = prefix && prefix.endsWith(".") ? `${prefix}>` : "";
      const keys = (await this.js<string[]>("kv-keys", bucket!, filter)).filter((k) =>
        k.startsWith(prefix),
      );
      const start = Number(params.cursor ?? 0) || 0;
      const page = keys.slice(start, start + limit);
      return {
        items: page.map((name) => ({ name })),
        ...(start + limit < keys.length ? { nextCursor: String(start + limit) } : {}),
      };
    }
    if (resourceTypeId === "nats-stream") {
      const [, stream] = splitId(id, 2);
      const prefix = (params.prefix ?? "").trim();
      const opts: Record<string, unknown> = { limit };
      // A number jumps to that sequence; anything else is a subject filter.
      if (/^\d+$/.test(prefix)) opts["cursor"] = Number(prefix);
      else if (prefix) opts["subject"] = prefix;
      if (params.cursor) opts["cursor"] = Number(params.cursor);
      const page = await this.js<{ items: MessageView[]; nextCursor?: number }>(
        "messages",
        stream!,
        JSON.stringify(opts),
      );
      return {
        items: page.items.map((m) => ({ name: `#${m.seq} ${m.subject}` })),
        ...(page.nextCursor !== undefined ? { nextCursor: String(page.nextCursor) } : {}),
      };
    }
    throw new NatsApiError(400, `NATS plugin: ${resourceTypeId} has no keys`);
  }

  async getKvValue(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    key: string,
  ): Promise<string> {
    const id = externalIdOf(resourceId);
    if (resourceTypeId === "nats-kv-bucket") {
      const [, bucket] = splitId(id, 2);
      const e = await this.js<KvEntryView | null>("kv-get", bucket!, key);
      if (!e || e.operation !== "PUT")
        throw new NatsApiError(404, `NATS plugin: "${key}" has no value`);
      return e.encoding === "base64" ? `(binary value, base64)\n${e.data ?? ""}` : (e.data ?? "");
    }
    if (resourceTypeId === "nats-stream") {
      const [, stream] = splitId(id, 2);
      const seq = /^#?(\d+)/.exec(key)?.[1];
      if (!seq) throw new NatsApiError(400, "NATS plugin: pick a message");
      const m = await this.js<MessageView | null>("message", stream!, seq);
      if (!m) throw new NatsApiError(404, `NATS plugin: message ${seq} was deleted`);
      return formatMessage(m);
    }
    throw new NatsApiError(400, `NATS plugin: ${resourceTypeId} has no keys`);
  }

  async putKvValue(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    key: string,
    value: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    if (resourceTypeId === "nats-kv-bucket") {
      const [account, bucket] = splitId(id, 2);
      await this.assertAccount(account!);
      await this.js("kv-put", bucket!, key, value);
      return;
    }
    if (resourceTypeId === "nats-stream") {
      if (/^#\d+/.test(key))
        throw new NatsApiError(
          400,
          "NATS plugin: stored messages cannot be changed; publish a new one",
        );
      // "+ Add key" on a stream publishes: the key is the subject.
      const [account] = splitId(id, 2);
      await this.assertAccount(account!);
      await this.js("publish", key.trim(), value, "", "jetstream", "5000", "");
      return;
    }
    throw new NatsApiError(400, `NATS plugin: ${resourceTypeId} has no keys`);
  }

  async deleteKvKey(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    key: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    if (resourceTypeId === "nats-kv-bucket") {
      const [account, bucket] = splitId(id, 2);
      await this.assertAccount(account!);
      await this.js("kv-del", bucket!, key);
      return;
    }
    if (resourceTypeId === "nats-stream") {
      const [account, stream] = splitId(id, 2);
      await this.assertAccount(account!);
      const seq = /^#?(\d+)/.exec(key)?.[1];
      if (!seq) throw new NatsApiError(400, "NATS plugin: pick a message");
      await this.js("message-delete", stream!, seq, "0");
      return;
    }
    throw new NatsApiError(400, `NATS plugin: ${resourceTypeId} has no keys`);
  }

  // -------------------------------------------------------------------------
  // File browser over an object store (object names with "/" read as folders)
  // -------------------------------------------------------------------------

  async listStorageObjects(bucket: string, prefix: string): Promise<StorageObject[]> {
    const objects = await this.js<ObjectView[]>("obj-list", bucket);
    const dirs = new Set<string>();
    const out: StorageObject[] = [];
    for (const o of objects) {
      if (!o.name.startsWith(prefix)) continue;
      const rest = o.name.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash !== -1) {
        const dir = rest.slice(0, slash + 1);
        if (!dirs.has(dir)) {
          dirs.add(dir);
          out.push({ key: prefix + dir, name: dir, size: 0, lastModified: "", isDirectory: true });
        }
        continue;
      }
      out.push({
        key: o.name,
        name: rest,
        size: o.size,
        lastModified: o.mtime,
        isDirectory: false,
      });
    }
    return out.sort((a, b) =>
      a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
    );
  }

  async uploadStorageObject(
    bucket: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    if (file.size > MAX_UPLOAD_BYTES)
      throw new NatsApiError(
        413,
        "NATS plugin: uploads here are limited to 32 MB; use the nats CLI for larger objects",
      );
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    onProgress?.(50);
    await this.js("obj-put", bucket, key, btoa(bin));
    onProgress?.(100);
  }

  makeStorageFolder(_bucket: string, _key: string): Promise<void> {
    return Promise.reject(
      new NatsApiError(
        400,
        'NATS plugin: object stores have no folders; upload with a "/" in the name instead',
      ),
    );
  }

  async deleteStorageObject(bucket: string, key: string): Promise<void> {
    if (!key.endsWith("/")) {
      await this.js("obj-remove", bucket, key);
      return;
    }
    const objects = await this.js<ObjectView[]>("obj-list", bucket);
    for (const o of objects.filter((x) => x.name.startsWith(key)))
      await this.js("obj-remove", bucket, o.name);
  }

  // -------------------------------------------------------------------------
  // Metrics, stats, quotas
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (
      ![
        "nats-server",
        "nats-stream",
        "nats-consumer",
        "nats-kv-bucket",
        "nats-object-store",
      ].includes(typeId)
    )
      return [];
    const f = (await this.getResource(typeId, resourceId, accountId)).fields;
    switch (typeId) {
      case "nats-server":
        return [
          {
            label: "Health",
            value: String(f["health"] ?? "?"),
            variant: f["health"] === "ok" ? "status-healthy" : "status-error",
          },
          ...(f["connections"] !== undefined
            ? [{ label: "Connections", value: String(f["connections"]) }]
            : []),
        ];
      case "nats-stream":
        return [{ label: "Messages", value: String(f["messages"] ?? 0) }];
      case "nats-kv-bucket":
        return [{ label: "Keys", value: String(f["keys"] ?? 0) }];
      case "nats-object-store":
        return [{ label: "Objects", value: String(f["objects"] ?? "?") }];
      default:
        return [{ label: "Pending", value: String(f["pending"] ?? 0) }];
    }
  }

  /** Point-in-time readings; nats-server keeps no history, so the host builds the series. */
  async fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<MetricSeries[]> {
    const now = Date.now();
    const pt = (label: string, unit: string, v: unknown): MetricSeries[] =>
      typeof v === "number" && Number.isFinite(v)
        ? [{ label, unit, points: [{ timestamp: now, value: v }] }]
        : [];
    const f = (await this.getResource(typeId, resourceId, accountId)).fields;
    switch (typeId) {
      case "nats-server":
        return [
          ...pt("Connections", "count", f["connections"]),
          ...pt("Subscriptions", "count", f["subscriptions"]),
          ...pt("Slow consumers", "count", f["slowConsumers"]),
          ...pt("Memory", "bytes", f["memory"]),
          ...pt("CPU", "%", f["cpu"]),
          ...pt("Messages in (total)", "count", f["inMsgs"]),
          ...pt("Messages out (total)", "count", f["outMsgs"]),
          ...pt("JetStream storage", "bytes", f["jsStorage"]),
          ...pt("JetStream memory", "bytes", f["jsMemory"]),
        ];
      case "nats-account":
        return [
          ...pt("Connections", "count", f["connections"]),
          ...pt("Subscriptions", "count", f["subscriptions"]),
          ...pt("JetStream storage", "bytes", f["jsStorage"]),
        ];
      case "nats-stream":
        return [
          ...pt("Messages", "count", f["messages"]),
          ...pt("Bytes", "bytes", f["bytes"]),
          ...pt("Consumers", "count", f["consumers"]),
        ];
      case "nats-consumer":
        return [
          ...pt("Pending", "count", f["pending"]),
          ...pt("Waiting for ack", "count", f["ackPending"]),
          ...pt("Redelivered", "count", f["redelivered"]),
        ];
      case "nats-kv-bucket":
        return [
          ...pt("Keys", "count", f["keys"]),
          ...pt("Values (all revisions)", "count", f["values"]),
          ...pt("Bytes", "bytes", f["bytes"]),
        ];
      case "nats-object-store":
        return [...pt("Objects", "count", f["objects"]), ...pt("Bytes", "bytes", f["bytes"])];
      default:
        return [];
    }
  }

  /** The server's own ceilings: max connections, and JetStream storage and memory. */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    if (!this.ctx) return [];
    const [varz, js] = await Promise.all([this.get<Varz>("/varz"), this.jsz()]);
    const region = varz.server_name || undefined;
    const out: QuotaUsage[] = [];
    const add = (
      id: string,
      name: string,
      used: number | undefined,
      limit: number | undefined,
      unit?: string,
    ) => {
      if (typeof used === "number" && typeof limit === "number" && limit > 0)
        out.push({
          id: `${varz.server_name ?? "server"}/${id}`,
          service: "server",
          name,
          ...(region ? { region } : {}),
          limit,
          used,
          ...(unit ? { unit } : {}),
          adjustable: true,
        });
    };
    add("connections", "Client connections", varz.connections, varz.max_connections);
    add(
      "js-storage",
      "JetStream storage",
      js?.storage ?? varz.jetstream?.stats?.storage,
      js?.config?.max_storage ?? varz.jetstream?.config?.max_storage,
      "bytes",
    );
    add(
      "js-memory",
      "JetStream memory",
      js?.memory ?? varz.jetstream?.stats?.memory,
      js?.config?.max_memory ?? varz.jetstream?.config?.max_memory,
      "bytes",
    );
    return out;
  }

  async verifyCredentials(): Promise<PreflightResult> {
    const httpChecks = PROBES.filter((p) => p.path).map(
      async (p): Promise<PreflightCapabilityCheck> => {
        if (!this.ctx)
          return {
            capabilityId: p.capability.id,
            status: "missing",
            missingPermissions: p.capability.requiredPermissions,
          };
        try {
          await this.get(p.path!);
          return { capabilityId: p.capability.id, status: "ok" };
        } catch (err) {
          const s = statusOf(err);
          if (
            s === 401 ||
            s === 403 ||
            (p.capability.id !== "varz" && (s === 404 || s === 400 || s === 503))
          )
            return {
              capabilityId: p.capability.id,
              status: "missing",
              missingPermissions: p.capability.requiredPermissions,
            };
          return {
            capabilityId: p.capability.id,
            status: "unknown",
            message: err instanceof Error ? err.message : String(err),
          };
        }
      },
    );
    const clientChecks = (async (): Promise<PreflightCapabilityCheck[]> => {
      const missing = (id: string, message?: string): PreflightCapabilityCheck => ({
        capabilityId: id,
        status: "missing",
        missingPermissions: PROBES.find((p) => p.capability.id === id)!.capability
          .requiredPermissions,
        ...(message ? { message } : {}),
      });
      if (!this.servers) return [missing("client"), missing("jetstream")];
      try {
        const info = await this.info();
        const js = info.jetstream;
        return [
          { capabilityId: "client", status: "ok" },
          js && !js.error
            ? { capabilityId: "jetstream", status: "ok" }
            : missing("jetstream", js?.error),
        ];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return [
          /credentials|authoriz/i.test(message)
            ? missing("client", message)
            : { capabilityId: "client", status: "unknown", message },
          { capabilityId: "jetstream", status: "unknown", message },
        ];
      }
    })();
    const checks = [...(await Promise.all(httpChecks)), ...(await clientChecks)];
    const varz = this.ctx ? await this.soft(this.get<Varz>("/varz")) : undefined;
    const server = varz ?? (this.servers ? (await this.soft(this.info()))?.server : undefined);
    return {
      checks,
      ...(server?.server_name
        ? { identity: `${server.server_name} (nats-server ${server.version ?? "?"})` }
        : {}),
    };
  }

  /** Server: routing stats. Stream and consumer: their configuration. Buckets: revisions and objects. */
  async describeResource(typeId: string, resourceId: string, accountId: string): Promise<string> {
    if (typeId === "nats-server") {
      if (!this.ctx) {
        const info = await this.info();
        return JSON.stringify(info.server ?? {}, null, 2);
      }
      const [subsz, varz] = await Promise.all([
        this.soft(this.get<Record<string, unknown>>("/subsz")),
        this.get<Varz & { http_req_stats?: Record<string, number> }>("/varz"),
      ]);
      const lines = [`nats-server ${varz.version ?? ""} (${varz.server_id ?? ""})`, ""];
      if (subsz) {
        lines.push("Subscription routing (/subsz)");
        for (const k of [
          "num_subscriptions",
          "num_cache",
          "num_inserts",
          "num_removes",
          "num_matches",
          "cache_hit_rate",
          "max_fanout",
          "avg_fanout",
        ])
          if (subsz[k] !== undefined) lines.push(`  ${k}: ${String(subsz[k])}`);
        lines.push("");
      }
      lines.push("Monitoring requests served");
      for (const [k, v] of Object.entries(varz.http_req_stats ?? {})) lines.push(`  ${k}: ${v}`);
      return lines.join("\n");
    }
    if (typeId === "nats-kv-bucket") {
      const [, bucket] = splitId(externalIdOf(resourceId), 2);
      const history = await this.js<KvEntryView[]>("kv-history", bucket!, "", 500);
      if (history.length === 0) return "No revisions in this bucket.";
      const byKey = new Map<string, KvEntryView[]>();
      for (const e of history) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
      return [...byKey.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([key, revs]) =>
            `${key}\n${revs
              .map(
                (e) =>
                  `  rev ${e.revision}  ${e.operation.padEnd(5)} ${e.created}  ${
                    e.operation === "PUT"
                      ? e.encoding === "base64"
                        ? `(${e.size} bytes, binary)`
                        : JSON.stringify(e.data ?? "").slice(0, 200)
                      : ""
                  }`,
              )
              .join("\n")}`,
        )
        .join("\n\n");
    }
    if (typeId === "nats-object-store") {
      const [, bucket] = splitId(externalIdOf(resourceId), 2);
      const objects = await this.js<ObjectView[]>("obj-list", bucket!);
      if (objects.length === 0) return "No objects in this store.";
      return objects
        .map(
          (o) =>
            `${o.name}\n  size ${o.size} bytes in ${o.chunks} chunks, modified ${o.mtime}\n  digest ${o.digest}${
              o.description ? `\n  ${o.description}` : ""
            }${o.link ? "\n  (link)" : ""}`,
        )
        .join("\n\n");
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    const cfg = r.resolvedOutputs["config"];
    if (cfg) {
      try {
        return JSON.stringify(JSON.parse(cfg), null, 2);
      } catch {
        return cfg;
      }
    }
    return Object.entries(r.fields)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join("\n");
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderNatsDetail(resource, { writable: !!this.servers });
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderNatsSidebar(resource);
  }
}

function stripData(entries: KvEntryView[]): KvEntryView[] {
  return entries.map((e) => {
    const { data, ...rest } = e;
    return e.encoding === "utf8" && data !== undefined
      ? { ...rest, data: data.length > 120 ? `${data.slice(0, 120)}…` : data }
      : rest;
  });
}

function formatMessage(m: MessageView): string {
  const lines = [
    `Subject: ${m.subject}`,
    `Sequence: ${m.seq}`,
    `Time: ${m.time}`,
    `Size: ${m.size} bytes`,
  ];
  if (m.headers) {
    lines.push("Headers:");
    for (const [k, v] of Object.entries(m.headers)) lines.push(`  ${k}: ${v}`);
  }
  lines.push("");
  lines.push(
    m.encoding === "base64" ? `(binary payload, base64)\n${m.data ?? ""}` : (m.data ?? ""),
  );
  return lines.join("\n");
}
