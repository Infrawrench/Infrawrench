import type {
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightResult,
  QuotaUsage,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { NatsContext } from "./api.js";
import { buildContext, joinId, NatsApiError, natsFetch, splitId, statusOf } from "./api.js";
import type { AccStat, Conn, Jsz, Varz } from "./mappers.js";
import {
  instance,
  mapAccount,
  mapConnection,
  mapConsumer,
  mapServer,
  mapStream,
} from "./mappers.js";
import { renderNatsDetail, renderNatsSidebar } from "./render.js";

const MAX_CONNECTIONS = 1024;
const JSZ_QUERY = {
  accounts: true,
  streams: true,
  consumers: true,
  config: true,
  limit: 1024,
} as const;

const PROBES: Array<{ capability: PreflightCapability; path: string }> = [
  {
    capability: {
      id: "varz",
      label: "Server information",
      description: "Read /varz: version, connections, traffic and limits.",
      requiredPermissions: [
        { id: "http_port", label: "Monitoring port enabled (http_port / -m 8222)" },
      ],
      essential: true,
    },
    path: "/varz",
  },
  {
    capability: {
      id: "jsz",
      label: "JetStream",
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

export class NatsClient implements PluginClient {
  private readonly ctx: NatsContext;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.ctx = buildContext(credentials, services?.http);
  }

  private get<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T> {
    return natsFetch<T>(this.ctx, path, query);
  }

  private soft<T>(p: Promise<T>): Promise<T | undefined> {
    return p.catch(() => undefined);
  }

  /** `/jsz` answers an error body (or nothing useful) when JetStream is off; read that as no streams. */
  private jsz(): Promise<Jsz | undefined> {
    return this.soft(this.get<Jsz>("/jsz", JSZ_QUERY));
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
    const [varz, js, health] = await Promise.all([
      this.get<Varz>("/varz"),
      this.jsz(),
      this.health(),
    ]);
    return mapServer(accountId, this.ctx.baseUrl, varz, js, health);
  }

  private async peers(accountId: string): Promise<ResourceInstance[]> {
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
      case "nats-stream": {
        const js = await this.jsz();
        return (js?.account_details ?? []).flatMap((a) =>
          (a.stream_detail ?? []).map((st) => mapStream(accountId, a.name ?? a.id ?? "", st)),
        );
      }
      case "nats-consumer": {
        const js = await this.jsz();
        return (js?.account_details ?? []).flatMap((a) =>
          (a.stream_detail ?? []).flatMap((st) =>
            (st.consumer_detail ?? []).map((c) =>
              mapConsumer(accountId, a.name ?? a.id ?? "", {
                ...c,
                stream_name: c.stream_name ?? st.name ?? "",
              }),
            ),
          ),
        );
      }
      case "nats-connection": {
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

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    if (typeId === "nats-server") return this.server(accountId);
    if (typeId === "nats-connection") {
      const res = await this.get<{ connections?: Conn[] | null }>("/connz", {
        cid: id,
        auth: true,
        state: "any",
      });
      const c = res.connections?.[0];
      if (!c) throw new NatsApiError(404, "NATS plugin: the connection is closed");
      return mapConnection(accountId, c);
    }
    if (typeId === "nats-stream" || typeId === "nats-consumer") {
      const [account] = splitId(id, 1);
      const js = await this.get<Jsz>("/jsz", { ...JSZ_QUERY, acc: account! });
      const all =
        typeId === "nats-stream"
          ? (js.account_details ?? []).flatMap((a) =>
              (a.stream_detail ?? []).map((st) => mapStream(accountId, a.name ?? a.id ?? "", st)),
            )
          : (js.account_details ?? []).flatMap((a) =>
              (a.stream_detail ?? []).flatMap((st) =>
                (st.consumer_detail ?? []).map((c) =>
                  mapConsumer(accountId, a.name ?? a.id ?? "", {
                    ...c,
                    stream_name: c.stream_name ?? st.name ?? "",
                  }),
                ),
              ),
            );
      const found = all.find((r) => r.externalId === id);
      if (!found)
        throw new NatsApiError(
          404,
          `NATS plugin: ${typeId === "nats-stream" ? "stream" : "consumer"} not found on this server`,
        );
      return found;
    }
    const found = (await this.listResources(typeId, accountId)).find((r) => r.externalId === id);
    if (!found) throw new NatsApiError(404, `NATS plugin: ${typeId} "${id}" not found`);
    return found;
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
  // Metrics, stats, quotas
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (typeId !== "nats-server" && typeId !== "nats-stream" && typeId !== "nats-consumer")
      return [];
    const f = (await this.getResource(typeId, resourceId, accountId)).fields;
    if (typeId === "nats-server")
      return [
        {
          label: "Health",
          value: String(f["health"] ?? "?"),
          variant: f["health"] === "ok" ? "status-healthy" : "status-error",
        },
        { label: "Connections", value: String(f["connections"] ?? 0) },
      ];
    if (typeId === "nats-stream") return [{ label: "Messages", value: String(f["messages"] ?? 0) }];
    return [{ label: "Pending", value: String(f["pending"] ?? 0) }];
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
      default:
        return [];
    }
  }

  /** The server's own ceilings: max connections, and JetStream storage and memory. */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
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
    const checks = await Promise.all(
      PROBES.map(async (p): Promise<PreflightCapabilityCheck> => {
        try {
          await this.get(p.path);
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
      }),
    );
    const varz = await this.soft(this.get<Varz>("/varz"));
    return {
      checks,
      ...(varz?.server_name
        ? { identity: `${varz.server_name} (nats-server ${varz.version ?? "?"})` }
        : {}),
    };
  }

  /** Server: subscription routing stats and the HTTP endpoints it serves. Stream and consumer: their configuration. */
  async describeResource(typeId: string, resourceId: string, accountId: string): Promise<string> {
    if (typeId === "nats-server") {
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
    return renderNatsDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderNatsSidebar(resource);
  }
}
