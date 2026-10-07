import type {
  CreateFieldConfig,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
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
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf } from "@infrawrench/plugin-base";
import type { RabbitContext } from "./api.js";
import {
  buildContext,
  RabbitApiError,
  rmqFetch,
  rmqOptionalList,
  rmqPaged,
  seg,
  splitId,
  statusOf,
} from "./api.js";
import type {
  Binding,
  Channel,
  Connection,
  Exchange,
  FederationLink,
  Overview,
  Permission,
  Policy,
  Queue,
  RabbitNode,
  RuntimeParameter,
  ShovelStatus,
  User,
  Vhost,
  VhostLimits,
} from "./mappers.js";
import {
  mapBinding,
  mapChannel,
  mapCluster,
  mapConnection,
  mapExchange,
  mapFederationUpstream,
  mapNode,
  mapPermission,
  mapPolicy,
  mapQueue,
  mapShovel,
  mapTopicPermission,
  mapUser,
  mapVhost,
  tagList,
} from "./mappers.js";
import { compact, counterRate, gauge, sampleQuery, snapshot } from "./metrics.js";
import { COMMANDS, renderRabbitDetail, renderRabbitSidebar } from "./render.js";
import {
  EXCHANGE_TYPES,
  OPERATOR_POLICY_APPLY_TO,
  POLICY_APPLY_TO,
  QUEUE_TYPES,
  USER_TAGS,
} from "./resource-types.js";

const MAX_QUEUES = 5000;
const MAX_EXCHANGES = 2000;
const MAX_CONNECTIONS = 1000;
const MAX_CHANNELS = 2000;
const PEEK_COUNT = 10;

const yesNo = [
  { id: "true", label: "Yes" },
  { id: "false", label: "No" },
];
const bool = (raw: string | undefined): boolean => /^(true|yes|1|on)$/i.test((raw ?? "").trim());

function numberOrUndefined(raw: string | undefined, label: string): number | undefined {
  const t = (raw ?? "").trim();
  if (!t) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n))
    throw new RabbitApiError(400, `RabbitMQ plugin: ${label} must be a number`);
  return n;
}

export function parseJsonObject(raw: string | undefined, label: string): Record<string, unknown> {
  const t = (raw ?? "").trim();
  if (!t) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    throw new RabbitApiError(400, `RabbitMQ plugin: ${label} must be a JSON object`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RabbitApiError(400, `RabbitMQ plugin: ${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * The management API answers 401 both for bad credentials and for a valid
 * user missing a tag ("Not administrator user", "Not monitor user"). Lists
 * gated on a tag read as empty for such a user instead of failing the sync.
 */
function isTagRefusal(err: unknown): boolean {
  return (
    statusOf(err) === 401 &&
    /not (administrator|monitor|management) user|not authorised to access/i.test(
      err instanceof Error ? err.message : "",
    )
  );
}

async function gated<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch (err) {
    if (isTagRefusal(err)) return [];
    throw err;
  }
}

const PROBES: Array<{ capability: PreflightCapability; path: string }> = [
  {
    capability: {
      id: "management",
      label: "Management API",
      description: "Read the overview, virtual hosts, exchanges, queues and bindings.",
      requiredPermissions: [{ id: "management", label: "User tag: management (or higher)" }],
      essential: true,
    },
    path: "/overview",
  },
  {
    capability: {
      id: "monitoring",
      label: "Nodes and all connections",
      description: "See cluster nodes, their metrics, and every user's connections and channels.",
      requiredPermissions: [{ id: "monitoring", label: "User tag: monitoring" }],
    },
    path: "/nodes",
  },
  {
    capability: {
      id: "policies",
      label: "Policies and parameters",
      description: "Manage policies, operator policies, shovels and federation upstreams.",
      requiredPermissions: [{ id: "policymaker", label: "User tag: policymaker" }],
    },
    path: "/policies",
  },
  {
    capability: {
      id: "admin",
      label: "Users, permissions and definitions",
      description:
        "Manage users, permissions, virtual hosts and limits, and export or import definitions.",
      requiredPermissions: [{ id: "administrator", label: "User tag: administrator" }],
    },
    path: "/users",
  },
];

export const RABBIT_PREFLIGHT = { capabilities: PROBES.map((p) => p.capability) };

export class RabbitClient implements PluginClient {
  private readonly ctx: RabbitContext;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.ctx = buildContext(credentials, services?.http);
  }

  private get<T>(path: string, query?: Record<string, string | number | boolean>): Promise<T> {
    return rmqFetch<T>(this.ctx, path, query ? { query } : {});
  }

  private vhosts(): Promise<Vhost[]> {
    return this.get<Vhost[]>("/vhosts").then((v) => v ?? []);
  }

  private async vhostLimits(): Promise<Map<string, Record<string, number>>> {
    const rows = await gated(this.get<VhostLimits[]>("/vhost-limits"));
    return new Map(rows.map((r) => [r.vhost ?? "/", r.value ?? {}]));
  }

  private async queues(): Promise<Queue[]> {
    const out: Queue[] = [];
    for (const v of await this.vhosts()) {
      if (out.length >= MAX_QUEUES) break;
      out.push(...(await rmqPaged<Queue>(this.ctx, `/queues/${seg(v.name ?? "/")}`, MAX_QUEUES)));
    }
    return out.slice(0, MAX_QUEUES);
  }

  private async bindings(): Promise<Binding[]> {
    const out: Binding[] = [];
    for (const v of await this.vhosts()) {
      out.push(...((await this.get<Binding[]>(`/bindings/${seg(v.name ?? "/")}`)) ?? []));
    }
    // Every queue is implicitly bound to the default exchange; those are not real objects.
    return out.filter((b) => b.source !== "");
  }

  private async whoami(): Promise<{ name?: string; tags?: string[] | string } | undefined> {
    return this.get<{ name?: string; tags?: string[] | string }>("/whoami").catch(() => undefined);
  }

  private async cluster(accountId: string): Promise<ResourceInstance> {
    const [overview, nodes, alarms] = await Promise.all([
      this.get<Overview>("/overview"),
      this.get<RabbitNode[]>("/nodes", { columns: "name,mem_alarm,disk_free_alarm" }).catch(
        () => undefined,
      ),
      rmqFetch<{ status?: string; reason?: string }>(this.ctx, "/health/checks/alarms")
        .then(() => "none")
        .catch((err: unknown) =>
          statusOf(err) === 503
            ? (err instanceof Error ? err.message : "").replace(/^.*?: /, "") || "alarm in effect"
            : "",
        ),
    ]);
    return mapCluster(accountId, this.ctx.baseUrl, overview ?? {}, nodes?.length, alarms);
  }

  private async userRows(accountId: string): Promise<ResourceInstance[]> {
    const [users, perms, limits, me] = await Promise.all([
      gated(this.get<User[]>("/users")),
      gated(this.get<Permission[]>("/permissions")),
      gated(this.get<Array<{ user?: string; value?: Record<string, number> }>>("/user-limits")),
      this.whoami(),
    ]);
    const limitMap = new Map(limits.map((l) => [l.user ?? "", l.value ?? {}]));
    return users.map((u) =>
      mapUser(
        accountId,
        { ...u, limits: { ...(u.limits ?? {}), ...(limitMap.get(u.name ?? "") ?? {}) } },
        perms.filter((p) => p.user === u.name).map((p) => p.vhost ?? "/"),
        me?.name,
      ),
    );
  }

  private async shovelRows(accountId: string): Promise<ResourceInstance[]> {
    const [defs, statuses] = await Promise.all([
      gated(rmqOptionalList<RuntimeParameter>(this.ctx, "/parameters/shovel")),
      rmqOptionalList<ShovelStatus>(this.ctx, "/shovels"),
    ]);
    const key = (v: string | undefined, n: string | undefined) => `${v ?? "/"}\u0000${n ?? ""}`;
    const status = new Map(
      statuses.filter((s) => s.type !== "static").map((s) => [key(s.vhost, s.name), s]),
    );
    return defs.map((d) =>
      mapShovel(accountId, d.vhost ?? "/", d.name ?? "", d.value, status.get(key(d.vhost, d.name))),
    );
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "rabbitmq-cluster":
        return [await this.cluster(accountId)];
      case "rabbitmq-node":
        return (await gated(this.get<RabbitNode[]>("/nodes"))).map((n) => mapNode(accountId, n));
      case "rabbitmq-vhost": {
        const [vhosts, limits] = await Promise.all([this.vhosts(), this.vhostLimits()]);
        return vhosts.map((v) => mapVhost(accountId, v, limits.get(v.name ?? "/")));
      }
      case "rabbitmq-exchange":
        return (await rmqPaged<Exchange>(this.ctx, "/exchanges", MAX_EXCHANGES))
          .filter((x) => x.name !== "")
          .map((x) => mapExchange(accountId, x));
      case "rabbitmq-queue":
        return (await this.queues()).map((q) => mapQueue(accountId, q));
      case "rabbitmq-binding":
        return (await this.bindings()).map((b) => mapBinding(accountId, b));
      case "rabbitmq-policy":
        return (await gated(this.get<Policy[]>("/policies"))).map((p) =>
          mapPolicy(accountId, "rabbitmq-policy", p),
        );
      case "rabbitmq-operator-policy":
        return (await gated(this.get<Policy[]>("/operator-policies"))).map((p) =>
          mapPolicy(accountId, "rabbitmq-operator-policy", p),
        );
      case "rabbitmq-user":
        return this.userRows(accountId);
      case "rabbitmq-permission":
        return (await gated(this.get<Permission[]>("/permissions"))).map((p) =>
          mapPermission(accountId, p),
        );
      case "rabbitmq-topic-permission":
        return (await gated(this.get<Permission[]>("/topic-permissions"))).map((p) =>
          mapTopicPermission(accountId, p),
        );
      case "rabbitmq-connection":
        return (await rmqPaged<Connection>(this.ctx, "/connections", MAX_CONNECTIONS)).map((c) =>
          mapConnection(accountId, c),
        );
      case "rabbitmq-channel":
        return (await rmqPaged<Channel>(this.ctx, "/channels", MAX_CHANNELS)).map((c) =>
          mapChannel(accountId, c),
        );
      case "rabbitmq-shovel":
        return this.shovelRows(accountId);
      case "rabbitmq-federation-upstream": {
        const [ups, links] = await Promise.all([
          gated(rmqOptionalList<RuntimeParameter>(this.ctx, "/parameters/federation-upstream")),
          rmqOptionalList<FederationLink>(this.ctx, "/federation-links"),
        ]);
        return ups.map((u) => mapFederationUpstream(accountId, u, links));
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
    switch (typeId) {
      case "rabbitmq-cluster":
        return this.cluster(accountId);
      case "rabbitmq-node":
        return mapNode(accountId, await this.get<RabbitNode>(`/nodes/${seg(id)}`));
      case "rabbitmq-vhost": {
        const [name] = splitId(id, 1);
        const [v, limits] = await Promise.all([
          this.get<Vhost>(`/vhosts/${seg(name!)}`),
          gated(this.get<VhostLimits[]>(`/vhost-limits/${seg(name!)}`)),
        ]);
        return mapVhost(accountId, v, limits[0]?.value);
      }
      case "rabbitmq-exchange": {
        const [vhost, name] = splitId(id, 2);
        return mapExchange(
          accountId,
          await this.get<Exchange>(`/exchanges/${seg(vhost!)}/${seg(name!)}`),
        );
      }
      case "rabbitmq-queue": {
        const [vhost, name] = splitId(id, 2);
        return mapQueue(accountId, await this.get<Queue>(`/queues/${seg(vhost!)}/${seg(name!)}`));
      }
      case "rabbitmq-binding": {
        const [vhost, source, kind, dest, props] = splitId(id, 5);
        const rows = await this.get<Binding[]>(
          `/bindings/${seg(vhost!)}/e/${seg(source!)}/${kind}/${seg(dest!)}`,
        );
        const b = (rows ?? []).find((x) => (x.properties_key ?? "~") === props);
        if (!b) throw new RabbitApiError(404, "RabbitMQ plugin: binding not found");
        return mapBinding(accountId, b);
      }
      case "rabbitmq-policy":
      case "rabbitmq-operator-policy": {
        const [vhost, name] = splitId(id, 2);
        const base = typeId === "rabbitmq-policy" ? "/policies" : "/operator-policies";
        return mapPolicy(
          accountId,
          typeId,
          await this.get<Policy>(`${base}/${seg(vhost!)}/${seg(name!)}`),
        );
      }
      case "rabbitmq-user": {
        const [name] = splitId(id, 1);
        const [u, limits, perms, me] = await Promise.all([
          this.get<User>(`/users/${seg(name!)}`),
          this.get<Array<{ value?: Record<string, number> }>>(`/user-limits/${seg(name!)}`).catch(
            () => [],
          ),
          this.get<Permission[]>(`/users/${seg(name!)}/permissions`).catch(() => []),
          this.whoami(),
        ]);
        return mapUser(
          accountId,
          { ...u, limits: { ...(u.limits ?? {}), ...(limits?.[0]?.value ?? {}) } },
          (perms ?? []).map((p) => p.vhost ?? "/"),
          me?.name,
        );
      }
      case "rabbitmq-permission": {
        const [vhost, user] = splitId(id, 2);
        return mapPermission(
          accountId,
          await this.get<Permission>(`/permissions/${seg(vhost!)}/${seg(user!)}`),
        );
      }
      case "rabbitmq-topic-permission": {
        const [vhost, user, exchange] = splitId(id, 3);
        const rows = await this.get<Permission[]>(
          `/topic-permissions/${seg(vhost!)}/${seg(user!)}`,
        );
        const p = (rows ?? []).find((x) => x.exchange === exchange);
        if (!p) throw new RabbitApiError(404, "RabbitMQ plugin: topic permission not found");
        return mapTopicPermission(accountId, p);
      }
      case "rabbitmq-connection": {
        const [name] = splitId(id, 1);
        return mapConnection(accountId, await this.get<Connection>(`/connections/${seg(name!)}`));
      }
      case "rabbitmq-channel": {
        const [name] = splitId(id, 1);
        return mapChannel(accountId, await this.get<Channel>(`/channels/${seg(name!)}`));
      }
      case "rabbitmq-shovel": {
        const [vhost, name] = splitId(id, 2);
        const [def, status] = await Promise.all([
          this.get<RuntimeParameter>(`/parameters/shovel/${seg(vhost!)}/${seg(name!)}`),
          this.get<ShovelStatus | ShovelStatus[]>(
            `/shovels/vhost/${seg(vhost!)}/${seg(name!)}`,
          ).catch(() => undefined),
        ]);
        const s = Array.isArray(status) ? status[0] : status;
        return mapShovel(accountId, vhost!, name!, def?.value, s);
      }
      case "rabbitmq-federation-upstream": {
        const [vhost, name] = splitId(id, 2);
        const [p, links] = await Promise.all([
          this.get<RuntimeParameter>(
            `/parameters/federation-upstream/${seg(vhost!)}/${seg(name!)}`,
          ),
          rmqOptionalList<FederationLink>(this.ctx, `/federation-links/${seg(vhost!)}`),
        ]);
        return mapFederationUpstream(accountId, p, links);
      }
      default:
        throw new RabbitApiError(404, `RabbitMQ plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "rabbitmq-cluster" && outputKey === "definitions") {
      return this.getManifest(resourceId, accountId);
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    const v = r.resolvedOutputs[outputKey] ?? r.fields[outputKey];
    return v === undefined ? "" : String(v);
  }

  /** Queue consumers and bindings, exchange bindings, user permissions: for the detail page. */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const id = resource.externalId ?? externalIdOf(resource.id);
    const extra: Record<string, string> = {};
    try {
      if (resource.resourceTypeId === "rabbitmq-queue") {
        const [vhost, name] = splitId(id, 2);
        const [q, binds] = await Promise.all([
          this.get<Queue>(`/queues/${seg(vhost!)}/${seg(name!)}`),
          this.get<Binding[]>(`/queues/${seg(vhost!)}/${seg(name!)}/bindings`),
        ]);
        extra["__consumers__"] = JSON.stringify(
          (q.consumer_details ?? []).map((c) => ({
            tag: c.consumer_tag ?? "",
            prefetch: String(c.prefetch_count ?? ""),
            ack: c.ack_required ? "manual" : "auto",
            active: c.active === false ? "no" : "yes",
            connection: c.channel_details?.connection_name ?? c.channel_details?.name ?? "",
            user: c.channel_details?.user ?? "",
          })),
        );
        extra["__bindings__"] = JSON.stringify(
          (binds ?? []).map((b) => ({
            source: b.source || "(default)",
            key: b.routing_key ?? "",
            args: b.arguments && Object.keys(b.arguments).length ? JSON.stringify(b.arguments) : "",
          })),
        );
      } else if (resource.resourceTypeId === "rabbitmq-exchange") {
        const [vhost, name] = splitId(id, 2);
        const binds = await this.get<Binding[]>(
          `/exchanges/${seg(vhost!)}/${seg(name!)}/bindings/source`,
        );
        extra["__bindings__"] = JSON.stringify(
          (binds ?? []).map((b) => ({
            destination: `${b.destination_type === "exchange" ? "exchange" : "queue"} ${b.destination ?? ""}`,
            key: b.routing_key ?? "",
            args: b.arguments && Object.keys(b.arguments).length ? JSON.stringify(b.arguments) : "",
          })),
        );
      } else if (resource.resourceTypeId === "rabbitmq-user") {
        const [name] = splitId(id, 1);
        const perms = await this.get<Permission[]>(`/users/${seg(name!)}/permissions`);
        extra["__permissions__"] = JSON.stringify(
          (perms ?? []).map((p) => ({
            vhost: p.vhost ?? "/",
            configure: p.configure ?? "",
            write: p.write ?? "",
            read: p.read ?? "",
          })),
        );
      }
    } catch {
      return resource;
    }
    return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
  }

  // -------------------------------------------------------------------------
  // Metrics, stats, quotas
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (!["rabbitmq-cluster", "rabbitmq-queue", "rabbitmq-node"].includes(resourceTypeId))
      return [];
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    if (resourceTypeId === "rabbitmq-node") {
      const alarm = f["memAlarm"] === true || f["diskFreeAlarm"] === true;
      return [
        {
          label: "State",
          value: f["running"] === false ? "down" : alarm ? "alarm" : "running",
          variant: f["running"] === false || alarm ? "status-error" : "status-healthy",
        },
      ];
    }
    return [
      { label: "Messages", value: String(f["messages"] ?? 0) },
      { label: "Consumers", value: String(f["consumers"] ?? 0) },
    ];
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const id = externalIdOf(resourceId);
    switch (resourceTypeId) {
      case "rabbitmq-cluster": {
        const o = await this.get<Overview>(
          "/overview",
          sampleQuery(timeRange, ["msg_rates", "lengths"]),
        );
        const m = o.message_stats;
        const q = o.queue_totals;
        const series = compact([
          counterRate("Published", m?.publish_details),
          counterRate("Delivered", m?.deliver_get_details),
          counterRate("Acknowledged", m?.ack_details),
          counterRate("Redelivered", m?.redeliver_details),
          counterRate("Unroutable dropped", m?.drop_unroutable_details),
          gauge("Messages", "count", q?.messages_details),
          gauge("Ready", "count", q?.messages_ready_details),
          gauge("Unacknowledged", "count", q?.messages_unacknowledged_details),
        ]);
        return series.length
          ? series
          : compact([
              snapshot("Messages", "count", q?.messages),
              snapshot("Connections", "count", o.object_totals?.connections),
              snapshot("Queues", "count", o.object_totals?.queues),
            ]);
      }
      case "rabbitmq-node": {
        const n = await this.get<RabbitNode>(
          `/nodes/${seg(id)}`,
          sampleQuery(timeRange, ["node_stats"]),
        );
        const series = compact([
          gauge("Memory used", "bytes", n.mem_used_details),
          gauge("Disk free", "bytes", n.disk_free_details),
          gauge("File descriptors", "count", n.fd_used_details),
          gauge("Sockets", "count", n.sockets_used_details),
          gauge("Erlang processes", "count", n.proc_used_details),
        ]);
        return series.length
          ? series
          : compact([
              snapshot("Memory used", "bytes", n.mem_used),
              snapshot("Disk free", "bytes", n.disk_free),
              snapshot("File descriptors", "count", n.fd_used),
            ]);
      }
      case "rabbitmq-vhost": {
        const [name] = splitId(id, 1);
        const v = await this.get<Vhost>(
          `/vhosts/${seg(name!)}`,
          sampleQuery(timeRange, ["msg_rates", "lengths"]),
        );
        return compact([
          counterRate("Published", v.message_stats?.publish_details),
          counterRate("Delivered", v.message_stats?.deliver_get_details),
          counterRate("Acknowledged", v.message_stats?.ack_details),
          gauge("Messages", "count", v.messages_details) ??
            snapshot("Messages", "count", v.messages),
        ]);
      }
      case "rabbitmq-exchange": {
        const [vhost, name] = splitId(id, 2);
        const x = await this.get<Exchange>(
          `/exchanges/${seg(vhost!)}/${seg(name!)}`,
          sampleQuery(timeRange, ["msg_rates"]),
        );
        return compact([
          counterRate("Published in", x.message_stats?.publish_in_details),
          counterRate("Published out", x.message_stats?.publish_out_details),
        ]);
      }
      case "rabbitmq-queue": {
        const [vhost, name] = splitId(id, 2);
        const q = await this.get<Queue>(
          `/queues/${seg(vhost!)}/${seg(name!)}`,
          sampleQuery(timeRange, ["msg_rates", "lengths"]),
        );
        const m = q.message_stats;
        return compact([
          gauge("Ready", "count", q.messages_ready_details) ??
            snapshot("Ready", "count", q.messages_ready),
          gauge("Unacknowledged", "count", q.messages_unacknowledged_details) ??
            snapshot("Unacknowledged", "count", q.messages_unacknowledged),
          counterRate("Published", m?.publish_details),
          counterRate("Delivered", m?.deliver_get_details),
          counterRate("Acknowledged", m?.ack_details),
          counterRate("Redelivered", m?.redeliver_details),
          snapshot("Consumers", "count", q.consumers),
        ]);
      }
      default:
        return [];
    }
  }

  /**
   * Limits the broker itself enforces, with usage from the same broker:
   * per-node file descriptors, sockets, Erlang processes and the memory high
   * watermark, plus any virtual host `max-queues` / `max-connections` limit.
   */
  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    const out: QuotaUsage[] = [];
    const nodes = await gated(this.get<RabbitNode[]>("/nodes"));
    for (const n of nodes) {
      const region = n.name;
      const add = (
        id: string,
        name: string,
        used: number | undefined,
        limit: number | undefined,
        unit?: string,
      ) => {
        if (typeof used === "number" && typeof limit === "number" && limit > 0)
          out.push({
            id: `node/${n.name}/${id}`,
            service: "node",
            name,
            ...(region ? { region } : {}),
            limit,
            used,
            ...(unit ? { unit } : {}),
            adjustable: true,
          });
      };
      add("fd", "File descriptors", n.fd_used, n.fd_total);
      add("sockets", "Sockets", n.sockets_used, n.sockets_total);
      add("proc", "Erlang processes", n.proc_used, n.proc_total);
      add("memory", "Memory high watermark", n.mem_used, n.mem_limit, "bytes");
    }
    const limits = await this.vhostLimits();
    if (limits.size) {
      const queues = await this.queues();
      const conns = await rmqPaged<Connection>(this.ctx, "/connections", MAX_CONNECTIONS, {
        columns: "vhost",
      });
      for (const [vhost, value] of limits) {
        const mq = value["max-queues"];
        if (typeof mq === "number" && mq > 0)
          out.push({
            id: `vhost/${vhost}/max-queues`,
            service: "vhost",
            name: `Queues in ${vhost}`,
            limit: mq,
            used: queues.filter((q) => q.vhost === vhost).length,
            unit: "queues",
            adjustable: true,
          });
        const mc = value["max-connections"];
        if (typeof mc === "number" && mc > 0)
          out.push({
            id: `vhost/${vhost}/max-connections`,
            service: "vhost",
            name: `Connections to ${vhost}`,
            limit: mc,
            used: conns.filter((c) => c.vhost === vhost).length,
            unit: "connections",
            adjustable: true,
          });
      }
    }
    return out;
  }

  async verifyCredentials(): Promise<PreflightResult> {
    const me = await this.get<{ name?: string; tags?: string[] | string }>("/whoami");
    const checks = await Promise.all(
      PROBES.map(async (p): Promise<PreflightCapabilityCheck> => {
        try {
          await this.get(p.path, { columns: "name" });
          return { capabilityId: p.capability.id, status: "ok" };
        } catch (err) {
          const s = statusOf(err);
          if (s === 401 || s === 403)
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
    const tags = tagList(me?.tags);
    return {
      checks,
      ...(me?.name ? { identity: `${me.name}${tags.length ? ` (${tags.join(", ")})` : ""}` } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  private async vhostPicker(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const names = (await this.vhosts().catch(() => [] as Vhost[])).map((v) => v.name ?? "/");
    return [
      {
        key: "vhost",
        label: "Virtual host",
        kind: "select",
        required: true,
        defaultValue: names.includes("/") ? "/" : (names[0] ?? "/"),
        options: names.map((n) => ({ id: n, label: n })),
      },
    ];
  }

  private parentVhost(
    parentResourceId: string | undefined,
    fields: Record<string, string>,
  ): string {
    if (parentResourceId) return splitId(externalIdOf(parentResourceId), 1)[0]!;
    const v = fields["vhost"] ?? "";
    if (!v) throw new RabbitApiError(400, "RabbitMQ plugin: pick a virtual host");
    return v;
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const parentVhost = parentResourceId
      ? splitId(externalIdOf(parentResourceId), 1)[0]
      : undefined;
    const inVhost = <T extends { vhost?: string }>(rows: T[]) =>
      parentVhost === undefined ? rows : rows.filter((r) => (r.vhost ?? "/") === parentVhost);
    const label = (vhost: string | undefined, name: string) =>
      parentVhost === undefined ? `${vhost ?? "/"} · ${name}` : name;
    switch (typeId) {
      case "rabbitmq-vhost":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "orders" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "tags",
              label: "Tags",
              kind: "string-list",
              required: false,
              placeholder: "production",
            },
            {
              key: "defaultQueueType",
              label: "Default queue type",
              kind: "select",
              required: false,
              defaultValue: "classic",
              options: QUEUE_TYPES.map((t) => ({ id: t, label: t })),
            },
          ],
        };
      case "rabbitmq-exchange":
        return {
          fields: [
            ...(await this.vhostPicker(parentResourceId)),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "orders.events",
            },
            {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "topic",
              options: EXCHANGE_TYPES.map((t) => ({ id: t, label: t })),
            },
            {
              key: "durable",
              label: "Durable",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: yesNo,
            },
            {
              key: "autoDelete",
              label: "Auto delete",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: yesNo,
            },
            {
              key: "internal",
              label: "Internal",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: yesNo,
              description: "Internal exchanges only receive messages from other exchanges.",
            },
            {
              key: "alternateExchange",
              label: "Alternate exchange",
              kind: "text",
              required: false,
              placeholder: "unrouted",
            },
            {
              key: "arguments",
              label: "Other arguments (JSON)",
              kind: "code",
              codeLanguage: "json",
              required: false,
              defaultValue: "{}",
            },
          ],
        };
      case "rabbitmq-queue":
        return {
          fields: [
            ...(await this.vhostPicker(parentResourceId)),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "orders.created",
            },
            {
              key: "queueType",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "quorum",
              options: [
                {
                  id: "quorum",
                  label: "Quorum",
                  description: "Replicated, durable; the default for data safety.",
                },
                {
                  id: "classic",
                  label: "Classic",
                  description: "Single node; supports exclusive and auto-delete.",
                },
                {
                  id: "stream",
                  label: "Stream",
                  description: "Append-only log with non-destructive reads.",
                },
              ],
            },
            {
              key: "durable",
              label: "Durable",
              kind: "select",
              required: false,
              defaultValue: "true",
              options: yesNo,
              showWhen: { fieldKey: "queueType", fieldValue: "classic" },
            },
            {
              key: "autoDelete",
              label: "Auto delete",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: yesNo,
              showWhen: { fieldKey: "queueType", fieldValue: "classic" },
            },
            { key: "messageTtl", label: "Message TTL (ms)", kind: "number", required: false },
            { key: "maxLength", label: "Max length (messages)", kind: "number", required: false },
            {
              key: "deadLetterExchange",
              label: "Dead letter exchange",
              kind: "text",
              required: false,
              placeholder: "dlx",
            },
            {
              key: "deadLetterRoutingKey",
              label: "Dead letter routing key",
              kind: "text",
              required: false,
            },
            {
              key: "arguments",
              label: "Other arguments (JSON)",
              kind: "code",
              codeLanguage: "json",
              required: false,
              defaultValue: "{}",
            },
          ],
        };
      case "rabbitmq-binding": {
        const [exchanges, queues] = await Promise.all([
          rmqPaged<Exchange>(this.ctx, "/exchanges", MAX_EXCHANGES).catch(() => [] as Exchange[]),
          (parentVhost !== undefined
            ? rmqPaged<Queue>(this.ctx, `/queues/${seg(parentVhost)}`, MAX_QUEUES, {
                columns: "name,vhost",
              })
            : this.queues()
          ).catch(() => [] as Queue[]),
        ]);
        const xs = inVhost(exchanges).filter((x) => x.name);
        const source = xs.filter((x) => !(x.internal === true && x.name?.startsWith("amq.")));
        const dests = [
          ...inVhost(queues).map((q) => ({
            id: `q/${encodeURIComponent(q.vhost ?? "/")}/${encodeURIComponent(q.name ?? "")}`,
            label: `Queue ${label(q.vhost, q.name ?? "")}`,
          })),
          ...xs.map((x) => ({
            id: `e/${encodeURIComponent(x.vhost ?? "/")}/${encodeURIComponent(x.name ?? "")}`,
            label: `Exchange ${label(x.vhost, x.name ?? "")}`,
          })),
        ];
        return {
          fields: [
            {
              key: "source",
              label: "From exchange",
              kind: "select",
              required: true,
              options: source.map((x) => ({
                id: `${encodeURIComponent(x.vhost ?? "/")}/${encodeURIComponent(x.name ?? "")}`,
                label: label(x.vhost, x.name ?? ""),
                description: x.type ?? "",
              })),
            },
            { key: "destination", label: "To", kind: "select", required: true, options: dests },
            {
              key: "routingKey",
              label: "Routing key",
              kind: "text",
              required: false,
              placeholder: "orders.*",
            },
            {
              key: "arguments",
              label: "Arguments (JSON)",
              kind: "code",
              codeLanguage: "json",
              required: false,
              defaultValue: "{}",
              description:
                'Headers exchanges match on these, e.g. {"x-match": "all", "region": "eu"}.',
            },
          ],
        };
      }
      case "rabbitmq-policy":
      case "rabbitmq-operator-policy": {
        const applyTo = typeId === "rabbitmq-policy" ? POLICY_APPLY_TO : OPERATOR_POLICY_APPLY_TO;
        return {
          fields: [
            ...(await this.vhostPicker(parentResourceId)),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "ttl-orders" },
            {
              key: "pattern",
              label: "Pattern",
              kind: "text",
              required: true,
              placeholder: "^orders\\.",
            },
            {
              key: "applyTo",
              label: "Apply to",
              kind: "select",
              required: true,
              defaultValue: applyTo[0]!,
              options: applyTo.map((a) => ({ id: a, label: a.replace(/_/g, " ") })),
            },
            {
              key: "priority",
              label: "Priority",
              kind: "number",
              required: false,
              defaultValue: "0",
            },
            {
              key: "definition",
              label: "Definition (JSON)",
              kind: "code",
              codeLanguage: "json",
              required: true,
              defaultValue:
                typeId === "rabbitmq-policy"
                  ? '{\n  "message-ttl": 60000\n}'
                  : '{\n  "max-length": 100000\n}',
            },
          ],
        };
      }
      case "rabbitmq-user":
        return {
          fields: [
            { key: "name", label: "Username", kind: "text", required: true },
            {
              key: "password",
              label: "Password",
              kind: "password",
              required: false,
              description:
                "Leave empty for a user that signs in with a client certificate or another backend.",
            },
            {
              key: "tags",
              label: "Tags",
              kind: "string-list",
              required: false,
              placeholder: "monitoring",
              description: `Any of ${USER_TAGS.join(", ")}.`,
            },
          ],
        };
      case "rabbitmq-permission":
      case "rabbitmq-topic-permission": {
        const users = await gated(this.get<User[]>("/users")).catch(() => [] as User[]);
        const topicExchanges =
          typeId === "rabbitmq-topic-permission"
            ? inVhost(
                await rmqPaged<Exchange>(this.ctx, "/exchanges", MAX_EXCHANGES).catch(
                  () => [] as Exchange[],
                ),
              ).filter((x) => x.type === "topic")
            : [];
        return {
          fields: [
            ...(await this.vhostPicker(parentResourceId)),
            {
              key: "user",
              label: "User",
              kind: "select",
              required: true,
              options: users.map((u) => ({ id: u.name ?? "", label: u.name ?? "" })),
            },
            ...(typeId === "rabbitmq-topic-permission"
              ? [
                  {
                    key: "exchange",
                    label: "Topic exchange",
                    kind: "select" as const,
                    required: true,
                    defaultValue: "amq.topic",
                    options: [
                      ...new Set(["amq.topic", ...topicExchanges.map((x) => x.name ?? "")]),
                    ].map((n) => ({
                      id: n,
                      label: n,
                    })),
                  },
                ]
              : [
                  {
                    key: "configure",
                    label: "Configure (regex)",
                    kind: "text" as const,
                    required: false,
                    defaultValue: ".*",
                    description: "Names the user may declare and delete. Empty grants nothing.",
                  },
                ]),
            {
              key: "write",
              label: "Write (regex)",
              kind: "text",
              required: false,
              defaultValue: ".*",
            },
            {
              key: "read",
              label: "Read (regex)",
              kind: "text",
              required: false,
              defaultValue: ".*",
            },
          ],
        };
      }
      case "rabbitmq-shovel":
        return {
          fields: [
            ...(await this.vhostPicker(parentResourceId)),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "orders-to-dr",
            },
            {
              key: "srcUri",
              label: "Source URI",
              kind: "text",
              required: true,
              defaultValue: "amqp://",
              description: "amqp:// alone means this broker, in this virtual host.",
            },
            {
              key: "srcType",
              label: "Source",
              kind: "select",
              required: true,
              defaultValue: "queue",
              options: [
                { id: "queue", label: "Queue" },
                { id: "exchange", label: "Exchange" },
              ],
            },
            {
              key: "srcQueue",
              label: "Source queue",
              kind: "text",
              required: false,
              showWhen: { fieldKey: "srcType", fieldValue: "queue" },
            },
            {
              key: "srcExchange",
              label: "Source exchange",
              kind: "text",
              required: false,
              showWhen: { fieldKey: "srcType", fieldValue: "exchange" },
            },
            {
              key: "srcExchangeKey",
              label: "Source routing key",
              kind: "text",
              required: false,
              defaultValue: "#",
              showWhen: { fieldKey: "srcType", fieldValue: "exchange" },
            },
            {
              key: "destUri",
              label: "Destination URI",
              kind: "text",
              required: true,
              placeholder: "amqps://user:password@dr.example.com/%2F",
            },
            {
              key: "destType",
              label: "Destination",
              kind: "select",
              required: true,
              defaultValue: "queue",
              options: [
                { id: "queue", label: "Queue" },
                { id: "exchange", label: "Exchange" },
              ],
            },
            {
              key: "destQueue",
              label: "Destination queue",
              kind: "text",
              required: false,
              showWhen: { fieldKey: "destType", fieldValue: "queue" },
            },
            {
              key: "destExchange",
              label: "Destination exchange",
              kind: "text",
              required: false,
              showWhen: { fieldKey: "destType", fieldValue: "exchange" },
            },
            {
              key: "ackMode",
              label: "Ack mode",
              kind: "select",
              required: false,
              defaultValue: "on-confirm",
              options: [
                { id: "on-confirm", label: "On confirm (safest)" },
                { id: "on-publish", label: "On publish" },
                { id: "no-ack", label: "No ack (fastest, may lose messages)" },
              ],
            },
            {
              key: "deleteAfter",
              label: "Stop after",
              kind: "select",
              required: false,
              defaultValue: "never",
              options: [
                { id: "never", label: "Never (keep running)" },
                { id: "queue-length", label: "Moving the messages queued now" },
              ],
              showWhen: { fieldKey: "srcType", fieldValue: "queue" },
            },
          ],
        };
      case "rabbitmq-federation-upstream":
        return {
          fields: [
            ...(await this.vhostPicker(parentResourceId)),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "eu-west" },
            {
              key: "uri",
              label: "Upstream URI",
              kind: "text",
              required: true,
              placeholder: "amqps://user:password@eu.example.com/%2F",
            },
            {
              key: "exchange",
              label: "Upstream exchange",
              kind: "text",
              required: false,
              description: "Defaults to the federated exchange's own name.",
            },
            {
              key: "queue",
              label: "Upstream queue",
              kind: "text",
              required: false,
              description: "Defaults to the federated queue's own name.",
            },
            {
              key: "prefetchCount",
              label: "Prefetch count",
              kind: "number",
              required: false,
              defaultValue: "1000",
            },
            {
              key: "reconnectDelay",
              label: "Reconnect delay (s)",
              kind: "number",
              required: false,
              defaultValue: "5",
            },
            {
              key: "ackMode",
              label: "Ack mode",
              kind: "select",
              required: false,
              defaultValue: "on-confirm",
              options: [
                { id: "on-confirm", label: "On confirm" },
                { id: "on-publish", label: "On publish" },
                { id: "no-ack", label: "No ack" },
              ],
            },
            {
              key: "maxHops",
              label: "Max hops",
              kind: "number",
              required: false,
              defaultValue: "1",
            },
          ],
        };
      default:
        throw new RabbitApiError(
          400,
          `RabbitMQ plugin: cannot create "${typeId}" from Infrawrench`,
        );
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const text = (k: string) => (fields[k] ?? "").trim();
    const ref = (ext: string) => `${accountId}:${typeId}:${ext}`;
    const enc = (...parts: string[]) => parts.map((p) => encodeURIComponent(p)).join("/");
    const need = (k: string, label: string) => {
      const v = text(k);
      if (!v) throw new RabbitApiError(400, `RabbitMQ plugin: ${label} is required`);
      return v;
    };
    switch (typeId) {
      case "rabbitmq-vhost": {
        const name = need("name", "a name");
        await rmqFetch(this.ctx, `/vhosts/${seg(name)}`, {
          method: "PUT",
          body: {
            description: text("description"),
            tags: tagList(fields["tags"]).join(","),
            ...(text("defaultQueueType") ? { default_queue_type: text("defaultQueueType") } : {}),
          },
        });
        return this.getResource(typeId, ref(enc(name)), accountId);
      }
      case "rabbitmq-exchange": {
        const vhost = this.parentVhost(parentResourceId, fields);
        const name = need("name", "a name");
        const args = parseJsonObject(fields["arguments"], "Arguments");
        if (text("alternateExchange")) args["alternate-exchange"] = text("alternateExchange");
        await rmqFetch(this.ctx, `/exchanges/${seg(vhost)}/${seg(name)}`, {
          method: "PUT",
          body: {
            type: text("type") || "direct",
            durable: fields["durable"] === undefined ? true : bool(fields["durable"]),
            auto_delete: bool(fields["autoDelete"]),
            internal: bool(fields["internal"]),
            arguments: args,
          },
        });
        return this.getResource(typeId, ref(enc(vhost, name)), accountId);
      }
      case "rabbitmq-queue": {
        const vhost = this.parentVhost(parentResourceId, fields);
        const name = need("name", "a name");
        const type = text("queueType") || "classic";
        const args = parseJsonObject(fields["arguments"], "Arguments");
        args["x-queue-type"] = type;
        const ttl = numberOrUndefined(fields["messageTtl"], "Message TTL");
        if (ttl !== undefined) args["x-message-ttl"] = ttl;
        const maxLen = numberOrUndefined(fields["maxLength"], "Max length");
        if (maxLen !== undefined) args["x-max-length"] = maxLen;
        if (text("deadLetterExchange")) args["x-dead-letter-exchange"] = text("deadLetterExchange");
        if (text("deadLetterRoutingKey"))
          args["x-dead-letter-routing-key"] = text("deadLetterRoutingKey");
        const classic = type === "classic";
        await rmqFetch(this.ctx, `/queues/${seg(vhost)}/${seg(name)}`, {
          method: "PUT",
          body: {
            // Quorum queues and streams must be durable and cannot auto-delete.
            durable: classic
              ? fields["durable"] === undefined
                ? true
                : bool(fields["durable"])
              : true,
            auto_delete: classic ? bool(fields["autoDelete"]) : false,
            arguments: args,
          },
        });
        return this.getResource(typeId, ref(enc(vhost, name)), accountId);
      }
      case "rabbitmq-binding": {
        const [vhost, source] = splitId(need("source", "a source exchange"), 2);
        const [kind, dvhost, dest] = splitId(need("destination", "a destination"), 3);
        if (dvhost !== vhost)
          throw new RabbitApiError(
            400,
            "RabbitMQ plugin: source and destination must be in the same virtual host",
          );
        const body = {
          routing_key: text("routingKey"),
          arguments: parseJsonObject(fields["arguments"], "Arguments"),
        };
        await rmqFetch(
          this.ctx,
          `/bindings/${seg(vhost!)}/e/${seg(source!)}/${kind}/${seg(dest!)}`,
          {
            method: "POST",
            body,
          },
        );
        const rows = await this.get<Binding[]>(
          `/bindings/${seg(vhost!)}/e/${seg(source!)}/${kind}/${seg(dest!)}`,
        );
        const made = (rows ?? []).find(
          (b) =>
            (b.routing_key ?? "") === body.routing_key &&
            JSON.stringify(b.arguments ?? {}) === JSON.stringify(body.arguments),
        );
        if (!made)
          throw new RabbitApiError(
            500,
            "RabbitMQ plugin: the binding was created but cannot be read back",
          );
        return mapBinding(accountId, made);
      }
      case "rabbitmq-policy":
      case "rabbitmq-operator-policy": {
        const vhost = this.parentVhost(parentResourceId, fields);
        const name = need("name", "a name");
        const base = typeId === "rabbitmq-policy" ? "/policies" : "/operator-policies";
        await rmqFetch(this.ctx, `${base}/${seg(vhost)}/${seg(name)}`, {
          method: "PUT",
          body: {
            pattern: need("pattern", "a pattern"),
            "apply-to": text("applyTo") || "all",
            priority: numberOrUndefined(fields["priority"], "Priority") ?? 0,
            definition: parseJsonObject(fields["definition"], "Definition"),
          },
        });
        return this.getResource(typeId, ref(enc(vhost, name)), accountId);
      }
      case "rabbitmq-user": {
        const name = need("name", "a username");
        const password = fields["password"] ?? "";
        await rmqFetch(this.ctx, `/users/${seg(name)}`, {
          method: "PUT",
          body: {
            ...(password ? { password } : { password_hash: "" }),
            tags: tagList(fields["tags"]).join(","),
          },
        });
        return this.getResource(typeId, ref(enc(name)), accountId);
      }
      case "rabbitmq-permission": {
        const vhost = this.parentVhost(parentResourceId, fields);
        const user = need("user", "a user");
        await rmqFetch(this.ctx, `/permissions/${seg(vhost)}/${seg(user)}`, {
          method: "PUT",
          body: {
            configure: fields["configure"] ?? "",
            write: fields["write"] ?? "",
            read: fields["read"] ?? "",
          },
        });
        return this.getResource(typeId, ref(enc(vhost, user)), accountId);
      }
      case "rabbitmq-topic-permission": {
        const vhost = this.parentVhost(parentResourceId, fields);
        const user = need("user", "a user");
        const exchange = need("exchange", "an exchange");
        await rmqFetch(this.ctx, `/topic-permissions/${seg(vhost)}/${seg(user)}`, {
          method: "PUT",
          body: { exchange, write: fields["write"] ?? "", read: fields["read"] ?? "" },
        });
        return this.getResource(typeId, ref(enc(vhost, user, exchange)), accountId);
      }
      case "rabbitmq-shovel": {
        const vhost = this.parentVhost(parentResourceId, fields);
        const name = need("name", "a name");
        const value: Record<string, unknown> = {
          "src-protocol": "amqp091",
          "src-uri": need("srcUri", "a source URI"),
          "dest-protocol": "amqp091",
          "dest-uri": need("destUri", "a destination URI"),
          "ack-mode": text("ackMode") || "on-confirm",
        };
        if (text("srcType") === "exchange") {
          value["src-exchange"] = need("srcExchange", "a source exchange");
          value["src-exchange-key"] = text("srcExchangeKey") || "#";
        } else {
          value["src-queue"] = need("srcQueue", "a source queue");
          if (text("deleteAfter") === "queue-length") value["src-delete-after"] = "queue-length";
        }
        if (text("destType") === "exchange")
          value["dest-exchange"] = need("destExchange", "a destination exchange");
        else value["dest-queue"] = need("destQueue", "a destination queue");
        await rmqFetch(this.ctx, `/parameters/shovel/${seg(vhost)}/${seg(name)}`, {
          method: "PUT",
          body: { value },
        });
        return this.getResource(typeId, ref(enc(vhost, name)), accountId);
      }
      case "rabbitmq-federation-upstream": {
        const vhost = this.parentVhost(parentResourceId, fields);
        const name = need("name", "a name");
        await this.putUpstream(vhost, name, { uri: need("uri", "an upstream URI") }, fields);
        return this.getResource(typeId, ref(enc(vhost, name)), accountId);
      }
      default:
        throw new RabbitApiError(
          400,
          `RabbitMQ plugin: cannot create "${typeId}" from Infrawrench`,
        );
    }
  }

  private async putUpstream(
    vhost: string,
    name: string,
    current: Record<string, unknown>,
    fields: Record<string, string>,
  ): Promise<void> {
    const value = { ...current };
    const setText = (field: string, key: string) => {
      if (!(field in fields)) return;
      const t = (fields[field] ?? "").trim();
      if (t) value[key] = t;
      else delete value[key];
    };
    const setNum = (field: string, key: string) => {
      if (!(field in fields)) return;
      const n = numberOrUndefined(fields[field], field);
      if (n === undefined) delete value[key];
      else value[key] = n;
    };
    setText("uri", "uri");
    setText("exchange", "exchange");
    setText("queue", "queue");
    setText("ackMode", "ack-mode");
    setNum("prefetchCount", "prefetch-count");
    setNum("reconnectDelay", "reconnect-delay");
    setNum("maxHops", "max-hops");
    setNum("expires", "expires");
    setNum("messageTtl", "message-ttl");
    if ("trustUserId" in fields) value["trust-user-id"] = bool(fields["trustUserId"]);
    await rmqFetch(this.ctx, `/parameters/federation-upstream/${seg(vhost)}/${seg(name)}`, {
      method: "PUT",
      body: { value },
    });
  }

  private async setLimit(path: string, raw: string | undefined, label: string): Promise<void> {
    const n = numberOrUndefined(raw, label);
    if (n === undefined || n < 0) {
      await rmqFetch(this.ctx, path, { method: "DELETE" }).catch((err: unknown) => {
        if (statusOf(err) !== 404) throw err;
      });
    } else {
      await rmqFetch(this.ctx, path, { method: "PUT", body: { value: n } });
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    const has = (k: string) => k in fields;
    const text = (k: string) => (fields[k] ?? "").trim();
    switch (typeId) {
      case "rabbitmq-cluster":
        if (has("clusterName")) {
          if (!text("clusterName"))
            throw new RabbitApiError(400, "RabbitMQ plugin: the cluster name cannot be empty");
          await rmqFetch(this.ctx, "/cluster-name", {
            method: "PUT",
            body: { name: text("clusterName") },
          });
        }
        break;
      case "rabbitmq-vhost": {
        const [name] = splitId(id, 1);
        const cur = await this.get<Vhost>(`/vhosts/${seg(name!)}`);
        if (has("description") || has("tags") || has("defaultQueueType") || has("tracing")) {
          const qt = has("defaultQueueType")
            ? text("defaultQueueType")
            : (cur.metadata?.default_queue_type ?? cur.default_queue_type ?? "");
          await rmqFetch(this.ctx, `/vhosts/${seg(name!)}`, {
            method: "PUT",
            body: {
              description: has("description")
                ? text("description")
                : (cur.metadata?.description ?? cur.description ?? ""),
              tags: (has("tags")
                ? tagList(fields["tags"])
                : tagList(cur.metadata?.tags ?? cur.tags)
              ).join(","),
              ...(qt && qt !== "undefined" ? { default_queue_type: qt } : {}),
              tracing: has("tracing") ? bool(fields["tracing"]) : (cur.tracing ?? false),
            },
          });
        }
        if (has("protectedFromDeletion")) {
          await rmqFetch(this.ctx, `/vhosts/${seg(name!)}/deletion/protection`, {
            method: bool(fields["protectedFromDeletion"]) ? "POST" : "DELETE",
          });
        }
        if (has("maxConnections"))
          await this.setLimit(
            `/vhost-limits/${seg(name!)}/max-connections`,
            fields["maxConnections"],
            "Max connections",
          );
        if (has("maxQueues"))
          await this.setLimit(
            `/vhost-limits/${seg(name!)}/max-queues`,
            fields["maxQueues"],
            "Max queues",
          );
        break;
      }
      case "rabbitmq-policy":
      case "rabbitmq-operator-policy": {
        const [vhost, name] = splitId(id, 2);
        const base = typeId === "rabbitmq-policy" ? "/policies" : "/operator-policies";
        const cur = await this.get<Policy>(`${base}/${seg(vhost!)}/${seg(name!)}`);
        await rmqFetch(this.ctx, `${base}/${seg(vhost!)}/${seg(name!)}`, {
          method: "PUT",
          body: {
            pattern: has("pattern") ? text("pattern") : (cur.pattern ?? ""),
            "apply-to": has("applyTo") ? text("applyTo") : (cur["apply-to"] ?? "all"),
            priority: has("priority")
              ? (numberOrUndefined(fields["priority"], "Priority") ?? 0)
              : (cur.priority ?? 0),
            definition: has("definition")
              ? parseJsonObject(fields["definition"], "Definition")
              : (cur.definition ?? {}),
          },
        });
        break;
      }
      case "rabbitmq-user": {
        const [name] = splitId(id, 1);
        if (has("tags")) {
          // A PUT without a password or hash clears the password (rabbit_auth_backend_internal:put_user),
          // so the current hash goes back with the new tags.
          const cur = await this.get<User>(`/users/${seg(name!)}`);
          await rmqFetch(this.ctx, `/users/${seg(name!)}`, {
            method: "PUT",
            body: {
              tags: tagList(fields["tags"]).join(","),
              password_hash: cur.password_hash ?? "",
              ...(cur.hashing_algorithm ? { hashing_algorithm: cur.hashing_algorithm } : {}),
            },
          });
        }
        if (has("maxConnections"))
          await this.setLimit(
            `/user-limits/${seg(name!)}/max-connections`,
            fields["maxConnections"],
            "Max connections",
          );
        if (has("maxChannels"))
          await this.setLimit(
            `/user-limits/${seg(name!)}/max-channels`,
            fields["maxChannels"],
            "Max channels",
          );
        break;
      }
      case "rabbitmq-permission": {
        const [vhost, user] = splitId(id, 2);
        const cur = await this.get<Permission>(`/permissions/${seg(vhost!)}/${seg(user!)}`);
        await rmqFetch(this.ctx, `/permissions/${seg(vhost!)}/${seg(user!)}`, {
          method: "PUT",
          body: {
            configure: has("configure") ? (fields["configure"] ?? "") : (cur.configure ?? ""),
            write: has("write") ? (fields["write"] ?? "") : (cur.write ?? ""),
            read: has("read") ? (fields["read"] ?? "") : (cur.read ?? ""),
          },
        });
        break;
      }
      case "rabbitmq-topic-permission": {
        const [vhost, user, exchange] = splitId(id, 3);
        const rows = await this.get<Permission[]>(
          `/topic-permissions/${seg(vhost!)}/${seg(user!)}`,
        );
        const cur = (rows ?? []).find((r) => r.exchange === exchange) ?? {};
        await rmqFetch(this.ctx, `/topic-permissions/${seg(vhost!)}/${seg(user!)}`, {
          method: "PUT",
          body: {
            exchange,
            write: has("write") ? (fields["write"] ?? "") : (cur.write ?? ""),
            read: has("read") ? (fields["read"] ?? "") : (cur.read ?? ""),
          },
        });
        break;
      }
      case "rabbitmq-federation-upstream": {
        const [vhost, name] = splitId(id, 2);
        const cur = await this.get<RuntimeParameter>(
          `/parameters/federation-upstream/${seg(vhost!)}/${seg(name!)}`,
        );
        const next = { ...fields };
        // The stored URI is redacted; an unchanged value must not overwrite the real one.
        if (has("uri") && text("uri").includes("•••")) delete next["uri"];
        await this.putUpstream(vhost!, name!, cur.value ?? {}, next);
        break;
      }
      default:
        throw new RabbitApiError(
          400,
          `RabbitMQ plugin: "${typeId}" cannot be edited from Infrawrench`,
        );
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const del = (path: string, headers?: Record<string, string>) =>
      rmqFetch(this.ctx, path, { method: "DELETE", ...(headers ? { headers } : {}) });
    switch (typeId) {
      case "rabbitmq-vhost":
        await del(`/vhosts/${seg(splitId(id, 1)[0]!)}`);
        return;
      case "rabbitmq-exchange": {
        const [vhost, name] = splitId(id, 2);
        if (name!.startsWith("amq."))
          throw new RabbitApiError(
            400,
            "RabbitMQ plugin: the built-in amq.* exchanges cannot be deleted",
          );
        await del(`/exchanges/${seg(vhost!)}/${seg(name!)}`);
        return;
      }
      case "rabbitmq-queue": {
        const [vhost, name] = splitId(id, 2);
        await del(`/queues/${seg(vhost!)}/${seg(name!)}`);
        return;
      }
      case "rabbitmq-binding": {
        const [vhost, source, kind, dest, props] = splitId(id, 5);
        await del(
          `/bindings/${seg(vhost!)}/e/${seg(source!)}/${kind}/${seg(dest!)}/${seg(props!)}`,
        );
        return;
      }
      case "rabbitmq-policy":
      case "rabbitmq-operator-policy": {
        const [vhost, name] = splitId(id, 2);
        await del(
          `${typeId === "rabbitmq-policy" ? "/policies" : "/operator-policies"}/${seg(vhost!)}/${seg(name!)}`,
        );
        return;
      }
      case "rabbitmq-user": {
        const [name] = splitId(id, 1);
        if (this.ctx.username && name === this.ctx.username)
          throw new RabbitApiError(
            400,
            "RabbitMQ plugin: refusing to delete the user this connection signs in as",
          );
        await del(`/users/${seg(name!)}`);
        return;
      }
      case "rabbitmq-permission": {
        const [vhost, user] = splitId(id, 2);
        await del(`/permissions/${seg(vhost!)}/${seg(user!)}`);
        return;
      }
      case "rabbitmq-topic-permission": {
        // The API only clears all of a user's topic permissions in a vhost at once,
        // so the ones for other exchanges are written back afterwards.
        const [vhost, user, exchange] = splitId(id, 3);
        const path = `/topic-permissions/${seg(vhost!)}/${seg(user!)}`;
        const keep = ((await this.get<Permission[]>(path)) ?? []).filter(
          (p) => p.exchange !== exchange,
        );
        await del(path);
        for (const p of keep)
          await rmqFetch(this.ctx, path, {
            method: "PUT",
            body: { exchange: p.exchange, write: p.write ?? "", read: p.read ?? "" },
          });
        return;
      }
      case "rabbitmq-connection":
        await del(`/connections/${seg(splitId(id, 1)[0]!)}`, {
          "X-Reason": "Closed from Infrawrench",
        });
        return;
      case "rabbitmq-shovel": {
        const [vhost, name] = splitId(id, 2);
        await del(`/parameters/shovel/${seg(vhost!)}/${seg(name!)}`);
        return;
      }
      case "rabbitmq-federation-upstream": {
        const [vhost, name] = splitId(id, 2);
        await del(`/parameters/federation-upstream/${seg(vhost!)}/${seg(name!)}`);
        return;
      }
      default:
        throw new RabbitApiError(
          400,
          `RabbitMQ plugin: "${typeId}" cannot be deleted from Infrawrench`,
        );
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    switch (`${typeId}:${actionId}`) {
      case "rabbitmq-cluster:rebalance":
        await rmqFetch(this.ctx, "/rebalance/queues", { method: "POST" });
        return;
      case "rabbitmq-queue:purge": {
        const [vhost, name] = splitId(id, 2);
        await rmqFetch(this.ctx, `/queues/${seg(vhost!)}/${seg(name!)}/contents`, {
          method: "DELETE",
        });
        return;
      }
      case "rabbitmq-shovel:restart": {
        const [vhost, name] = splitId(id, 2);
        await rmqFetch(this.ctx, `/shovels/vhost/${seg(vhost!)}/${seg(name!)}/restart`, {
          method: "DELETE",
        });
        return;
      }
      default:
        throw new RabbitApiError(
          400,
          `RabbitMQ plugin: unknown action "${actionId}" for "${typeId}"`,
        );
    }
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const values = decodePromptArgs(args);
    const id = externalIdOf(resourceId);
    if (
      command === COMMANDS.editDefinition &&
      (typeId === "rabbitmq-policy" || typeId === "rabbitmq-operator-policy")
    ) {
      await this.updateResource(typeId, resourceId, accountId, {
        definition: values["definition"] ?? "",
      });
      return { ok: true };
    }
    if (command === COMMANDS.setPassword && typeId === "rabbitmq-user") {
      const [name] = splitId(id, 1);
      const password = values["password"] ?? "";
      if (!password) throw new RabbitApiError(400, "RabbitMQ plugin: enter a password");
      const cur = await this.get<User>(`/users/${seg(name!)}`);
      await rmqFetch(this.ctx, `/users/${seg(name!)}`, {
        method: "PUT",
        body: { password, tags: tagList(cur.tags).join(",") },
      });
      return { ok: true };
    }
    if (command === COMMANDS.closeConnection && typeId === "rabbitmq-connection") {
      await rmqFetch(this.ctx, `/connections/${seg(splitId(id, 1)[0]!)}`, {
        method: "DELETE",
        headers: { "X-Reason": (values["reason"] ?? "").trim() || "Closed from Infrawrench" },
      });
      return { ok: true };
    }
    throw new RabbitApiError(400, `RabbitMQ plugin: unknown command "${command}"`);
  }

  /**
   * Queue peek: `POST /queues/{vhost}/{name}/get` with `ack_requeue_true`, so
   * the messages go back on the queue (marked redelivered), the same thing the
   * management UI's Get messages button does. Streams do not support it.
   */
  async describeResource(typeId: string, resourceId: string, accountId: string): Promise<string> {
    if (typeId !== "rabbitmq-queue") {
      const r = await this.getResource(typeId, resourceId, accountId);
      return Object.entries(r.fields)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join("\n");
    }
    const [vhost, name] = splitId(externalIdOf(resourceId), 2);
    const q = await this.get<Queue>(`/queues/${seg(vhost!)}/${seg(name!)}`, {
      disable_stats: true,
    });
    const head = [
      `Queue ${name} in ${vhost} (${q.type ?? "classic"})`,
      `Messages: ${q.messages ?? 0} (${q.messages_ready ?? 0} ready, ${q.messages_unacknowledged ?? 0} unacknowledged)`,
      "",
    ];
    if (q.type === "stream") {
      return [
        ...head,
        "Streams are read with a stream consumer; the management API cannot peek them.",
      ].join("\n");
    }
    const msgs = await rmqFetch<
      Array<{
        payload?: string;
        payload_encoding?: string;
        payload_bytes?: number;
        redelivered?: boolean;
        exchange?: string;
        routing_key?: string;
        properties?: Record<string, unknown>;
      }>
    >(this.ctx, `/queues/${seg(vhost!)}/${seg(name!)}/get`, {
      method: "POST",
      body: { count: PEEK_COUNT, ackmode: "ack_requeue_true", encoding: "auto", truncate: 50_000 },
    });
    if (!msgs?.length) return [...head, "No ready messages to peek."].join("\n");
    const lines = [
      ...head,
      `First ${msgs.length} ready message(s), requeued after reading (they are now marked redelivered):`,
      "",
    ];
    msgs.forEach((m, i) => {
      lines.push(
        `#${i + 1}  exchange=${m.exchange || "(default)"}  routing_key=${m.routing_key ?? ""}  bytes=${m.payload_bytes ?? 0}${m.redelivered ? "  redelivered" : ""}`,
      );
      const props = m.properties ?? {};
      if (Object.keys(props).length) lines.push(`    properties: ${JSON.stringify(props)}`);
      lines.push(`    payload (${m.payload_encoding ?? "string"}): ${m.payload ?? ""}`, "");
    });
    return lines.join("\n");
  }

  /**
   * Publish through `POST /exchanges/{vhost}/{exchange}/publish` (the docs'
   * heading says PUT; the handler only allows POST). A queue publishes through
   * the default exchange, addressed as `amq.default`, with its name as key.
   */
  async publishMessage(
    typeId: string,
    resourceId: string,
    _accountId: string,
    payload: PublishMessagePayload,
  ): Promise<PublishMessageResult> {
    const [vhost, name] = splitId(externalIdOf(resourceId), 2);
    const extra = (k: string) => {
      const v = payload.extras[k];
      return typeof v === "string" ? v.trim() : "";
    };
    const headers = payload.extras["headers"];
    const properties: Record<string, unknown> = {
      delivery_mode: extra("deliveryMode") === "1" ? 1 : 2,
      ...(extra("contentType") ? { content_type: extra("contentType") } : {}),
      ...(extra("correlationId") ? { correlation_id: extra("correlationId") } : {}),
      ...(extra("messageId") ? { message_id: extra("messageId") } : {}),
      ...(headers && typeof headers === "object" && Object.keys(headers).length ? { headers } : {}),
    };
    const exchange = typeId === "rabbitmq-queue" ? "amq.default" : name!;
    const routingKey = typeId === "rabbitmq-queue" ? name! : extra("routingKey");
    const res = await rmqFetch<{ routed?: boolean }>(
      this.ctx,
      `/exchanges/${seg(vhost!)}/${seg(exchange)}/publish`,
      {
        method: "POST",
        body: {
          properties,
          routing_key: routingKey,
          payload: payload.body,
          payload_encoding: "string",
        },
      },
    );
    return {
      summary: res?.routed
        ? `Routed${routingKey ? ` with key ${routingKey}` : ""}`
        : "Accepted but not routed to any queue (no binding matched)",
    };
  }

  /** Definitions export of the whole cluster (users with password hashes, vhosts, topology, policies). */
  async getManifest(_resourceId: string, _accountId: string): Promise<string> {
    const defs = await this.get<unknown>("/definitions");
    return JSON.stringify(defs ?? {}, null, 2);
  }

  /** Definitions import: additive, objects in the document are created or updated, nothing is deleted. */
  async applyManifest(_resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const body = parseJsonObject(manifest, "Definitions");
    await rmqFetch(this.ctx, "/definitions", { method: "POST", body });
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderRabbitDetail(resource, this.ctx.baseUrl);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderRabbitSidebar(resource);
  }
}
