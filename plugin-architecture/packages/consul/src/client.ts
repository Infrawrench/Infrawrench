import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  KvListResult,
  MetricSeries,
  PluginClient,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf } from "@infrawrench/plugin-base";
import type { ConsulContext, Query } from "./api.js";
import {
  buildContext,
  ConsulApiError,
  consulFetch,
  encodeKey,
  joinId,
  splitId,
  statusOf,
} from "./api.js";
import type {
  AclPolicy,
  AclRole,
  AclToken,
  CatalogNode,
  Check,
  ConfigEntry,
  Intention,
  Peering,
  Session,
} from "./mappers.js";
import {
  instance,
  intentionId,
  mapCheck,
  mapConfigEntry,
  mapIntention,
  mapNode,
  mapPeering,
  mapPolicy,
  mapRole,
  mapService,
  mapSession,
  mapToken,
  metaText,
  parseMeta,
} from "./mappers.js";
import { COMMANDS, renderConsulDetail, renderConsulSidebar } from "./render.js";
import { CONFIG_KINDS } from "./resource-types.js";

const MAX_CHECKS = 3000;
const KV_PAGE = 200;
const BUILTIN_TOKENS = new Set(["00000000-0000-0000-0000-000000000002"]);

const list = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const POLICY_TEMPLATE = `service_prefix "" {
  policy = "read"
}

node_prefix "" {
  policy = "read"
}
`;

export function configTemplate(kind: string, name: string): string {
  const base: Record<string, unknown> = { Kind: kind, Name: name };
  switch (kind) {
    case "service-defaults":
      Object.assign(base, { Protocol: "http" });
      break;
    case "proxy-defaults":
      base["Name"] = "global";
      Object.assign(base, { Config: { protocol: "http" } });
      break;
    case "service-intentions":
      Object.assign(base, { Sources: [{ Name: "web", Action: "allow" }] });
      break;
    case "service-splitter":
      Object.assign(base, {
        Splits: [
          { Weight: 90, ServiceSubset: "v1" },
          { Weight: 10, ServiceSubset: "v2" },
        ],
      });
      break;
    case "service-resolver":
      Object.assign(base, {
        DefaultSubset: "v1",
        Subsets: {
          v1: { Filter: "Service.Meta.version == v1" },
          v2: { Filter: "Service.Meta.version == v2" },
        },
      });
      break;
    case "service-router":
      Object.assign(base, {
        Routes: [{ Match: { HTTP: { PathPrefix: "/admin" } }, Destination: { Service: "admin" } }],
      });
      break;
    case "mesh":
      base["Name"] = "mesh";
      Object.assign(base, { TransparentProxy: { MeshDestinationsOnly: false } });
      break;
    case "exported-services":
      Object.assign(base, { Services: [{ Name: "web", Consumers: [{ Peer: "cluster-02" }] }] });
      break;
  }
  return JSON.stringify(base, null, 2);
}

const PROBES: Array<{ capability: PreflightCapability; path: string; query?: Query }> = [
  {
    capability: {
      id: "catalog",
      label: "Catalog and health",
      description: "Read nodes, services and health checks.",
      requiredPermissions: [
        {
          id: 'node_prefix "" { policy = "read" }  service_prefix "" { policy = "read" }',
          label: "node and service read",
        },
      ],
      essential: true,
    },
    path: "/catalog/services",
  },
  {
    capability: {
      id: "kv",
      label: "Key/value store",
      description: "Browse, read and write keys.",
      requiredPermissions: [{ id: 'key_prefix "" { policy = "write" }', label: "key write" }],
    },
    path: "/kv/",
    query: { keys: true, separator: "/" },
  },
  {
    capability: {
      id: "mesh",
      label: "Intentions and config entries",
      description: "Read and write intentions and configuration entries.",
      requiredPermissions: [
        {
          id: 'mesh = "write"  service_prefix "" { policy = "write" intentions = "write" }',
          label: "mesh and intentions write",
        },
      ],
    },
    path: "/connect/intentions",
  },
  {
    capability: {
      id: "acl",
      label: "ACL policies, roles and tokens",
      description: "Manage ACLs.",
      requiredPermissions: [{ id: 'acl = "write"', label: "acl write" }],
    },
    path: "/acl/policies",
  },
  {
    capability: {
      id: "operator",
      label: "Operator (Raft, autopilot, peerings)",
      description: "Raft configuration, autopilot health and cluster peering.",
      requiredPermissions: [
        { id: 'operator = "write"  peering = "write"', label: "operator and peering write" },
      ],
    },
    path: "/operator/raft/configuration",
  },
];

export const CONSUL_PREFLIGHT = { capabilities: PROBES.map((p) => p.capability) };

interface AgentSelf {
  Config?: { Datacenter?: string; NodeName?: string; Server?: boolean; Version?: string };
}

export class ConsulClient implements PluginClient {
  private readonly ctx: ConsulContext;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.ctx = buildContext(credentials, services?.http);
  }

  private get<T>(path: string, query?: Query): Promise<T> {
    return consulFetch<T>(this.ctx, path, query ? { query } : {});
  }

  private put<T>(path: string, body: unknown, query?: Query): Promise<T> {
    return consulFetch<T>(this.ctx, path, { method: "PUT", body, ...(query ? { query } : {}) });
  }

  private soft<T>(p: Promise<T>): Promise<T | undefined> {
    return p.catch(() => undefined);
  }

  /** Enterprise-only or optional lists: a 404 (and the CE "not supported" 400/501) reads as empty; ACLs off reads as empty. */
  private async optional<T>(p: Promise<T[] | null>): Promise<T[]> {
    try {
      return (await p) ?? [];
    } catch (err) {
      const s = statusOf(err);
      const msg = err instanceof Error ? err.message : "";
      if (
        s === 404 ||
        s === 501 ||
        (s === 400 && /not (supported|enabled)|ACL support disabled|enterprise/i.test(msg))
      )
        return [];
      if (s === 401 && /ACL support disabled/i.test(msg)) return [];
      throw err;
    }
  }

  private checks(): Promise<Check[]> {
    return this.get<Check[]>("/health/state/any").then((c) => c ?? []);
  }

  private async cluster(accountId: string): Promise<ResourceInstance> {
    const [leader, self, raft, autopilot, dcs, members, nodes, services, checks] =
      await Promise.all([
        this.get<string>("/status/leader"),
        this.soft(this.get<AgentSelf>("/agent/self")),
        this.soft(
          this.get<{ Servers?: Array<{ Voter?: boolean }> }>("/operator/raft/configuration"),
        ),
        this.soft(
          this.get<{ Healthy?: boolean; FailureTolerance?: number }>("/operator/autopilot/health"),
        ),
        this.soft(this.get<string[]>("/catalog/datacenters")),
        this.soft(this.get<unknown[]>("/agent/members")),
        this.soft(this.get<CatalogNode[]>("/catalog/nodes")),
        this.soft(this.get<Record<string, string[]>>("/catalog/services")),
        this.soft(this.checks()),
      ]);
    const dc = self?.Config?.Datacenter ?? this.ctx.datacenter ?? "";
    const r = instance(
      accountId,
      "consul-cluster",
      "cluster",
      `${dc || "consul"} · ${new URL(this.ctx.address).host}`,
      {
        address: this.ctx.address,
        version: self?.Config?.Version,
        datacenter: dc,
        agentNode: self?.Config?.NodeName,
        agentIsServer: self?.Config?.Server,
        leader: leader ?? "",
        raftServers: raft?.Servers?.length,
        voters: raft?.Servers?.filter((s) => s.Voter).length,
        healthy: autopilot?.Healthy,
        failureTolerance: autopilot?.FailureTolerance,
        datacenters: dcs?.join(", "),
        members: members?.length,
        nodes: nodes?.length,
        services: services ? Object.keys(services).length : undefined,
        criticalChecks: checks?.filter((c) => c.Status === "critical").length,
        warningChecks: checks?.filter((c) => c.Status === "warning").length,
      },
    );
    r.resolvedOutputs = { address: this.ctx.address, datacenter: dc };
    return r;
  }

  private async configEntries(): Promise<ConfigEntry[]> {
    const lists = await Promise.all(
      CONFIG_KINDS.map((k) =>
        this.optional(this.get<ConfigEntry[]>(`/config/${k}`)).catch(() => [] as ConfigEntry[]),
      ),
    );
    return lists.flat();
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "consul-cluster":
        return [await this.cluster(accountId)];
      case "consul-node": {
        const [nodes, checks] = await Promise.all([
          this.get<CatalogNode[]>("/catalog/nodes"),
          this.soft(this.checks()),
        ]);
        return (nodes ?? []).map((n) =>
          mapNode(
            accountId,
            n,
            (checks ?? []).filter((c) => c.Node === n.Node),
          ),
        );
      }
      case "consul-service": {
        const [services, checks] = await Promise.all([
          this.get<Record<string, string[]>>("/catalog/services"),
          this.soft(this.checks()),
        ]);
        return Object.entries(services ?? {}).map(([name, tags]) =>
          mapService(
            accountId,
            name,
            tags ?? [],
            (checks ?? []).filter((c) => c.ServiceName === name),
            {
              ...(name === "consul" ? { kind: "consul servers" } : {}),
            },
          ),
        );
      }
      case "consul-check":
        return (await this.checks()).slice(0, MAX_CHECKS).map((c) => mapCheck(accountId, c));
      case "consul-intention":
        return (await this.optional(this.get<Intention[]>("/connect/intentions"))).map((i) =>
          mapIntention(accountId, i),
        );
      case "consul-config-entry":
        return (await this.configEntries()).map((e) => mapConfigEntry(accountId, e));
      case "consul-acl-policy": {
        // The list omits rules; read each (policies are few) so the detail and Terraform have them.
        const policies = await this.optional(this.get<AclPolicy[]>("/acl/policies"));
        return Promise.all(
          policies
            .slice(0, 300)
            .map(async (p) =>
              mapPolicy(
                accountId,
                (await this.soft(
                  this.get<AclPolicy>(`/acl/policy/${encodeURIComponent(p.ID ?? "")}`),
                )) ?? p,
              ),
            ),
        );
      }
      case "consul-acl-role":
        return (await this.optional(this.get<AclRole[]>("/acl/roles"))).map((r) =>
          mapRole(accountId, r),
        );
      case "consul-acl-token":
        return (await this.optional(this.get<AclToken[]>("/acl/tokens"))).map((t) =>
          mapToken(accountId, t),
        );
      case "consul-session":
        return ((await this.get<Session[]>("/session/list")) ?? []).map((s) =>
          mapSession(accountId, s),
        );
      case "consul-peering":
        return (await this.optional(this.get<Peering[]>("/peerings"))).map((p) =>
          mapPeering(accountId, p),
        );
      case "consul-namespace":
        return (
          await this.optional(
            this.get<
              Array<{
                Name?: string;
                Description?: string;
                Partition?: string;
                Meta?: Record<string, string>;
              }>
            >("/namespaces"),
          )
        ).map((n) => this.mapNamespace(accountId, n));
      case "consul-partition":
        return (
          await this.optional(
            this.get<Array<{ Name?: string; Description?: string }>>("/partitions"),
          )
        ).map((p) =>
          instance(
            accountId,
            "consul-partition",
            joinId(p.Name ?? ""),
            p.Name ?? "",
            { name: p.Name, description: p.Description },
            { resolvedOutputs: { name: p.Name ?? "" } },
          ),
        );
      default:
        return [];
    }
  }

  private mapNamespace(
    accountId: string,
    n: { Name?: string; Description?: string; Partition?: string; Meta?: Record<string, string> },
  ): ResourceInstance {
    return instance(
      accountId,
      "consul-namespace",
      joinId(n.Name ?? ""),
      n.Name ?? "",
      {
        name: n.Name,
        description: n.Description ?? "",
        partition: n.Partition,
        meta: metaText(n.Meta),
      },
      { resolvedOutputs: { name: n.Name ?? "" } },
    );
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "consul-cluster":
        return this.cluster(accountId);
      case "consul-node": {
        const [name] = splitId(id, 1);
        const [svc, checks] = await Promise.all([
          this.get<{ Node?: CatalogNode; Services?: unknown[] } | null>(
            `/catalog/node-services/${encodeURIComponent(name!)}`,
          ),
          this.soft(this.get<Check[]>(`/health/node/${encodeURIComponent(name!)}`)),
        ]);
        if (!svc?.Node)
          throw new ConsulApiError(404, `Consul plugin: node "${name}" is not in the catalog`);
        return mapNode(accountId, svc.Node, checks ?? [], svc.Services?.length ?? 0);
      }
      case "consul-service": {
        const [name, ns] = splitId(id, 1);
        const rows = await this.get<
          Array<{
            Service?: { Tags?: string[]; Kind?: string; Namespace?: string };
            Checks?: Check[];
          }>
        >(`/health/service/${encodeURIComponent(name!)}`, ns ? { ns } : undefined);
        return mapService(
          accountId,
          name!,
          (rows ?? []).flatMap((r) => r.Service?.Tags ?? []),
          (rows ?? []).flatMap((r) => r.Checks ?? []),
          {
            instances: rows?.length ?? 0,
            ...(rows?.[0]?.Service?.Kind ? { kind: rows[0].Service.Kind } : {}),
            ...(ns ? { namespace: ns } : {}),
          },
        );
      }
      case "consul-intention": {
        const [source, destination] = splitId(id, 2);
        if (source!.startsWith("peer:")) {
          const all = await this.get<Intention[]>("/connect/intentions");
          const i = (all ?? []).find((x) => intentionId(x) === id);
          if (!i) throw new ConsulApiError(404, "Consul plugin: intention not found");
          return mapIntention(accountId, i);
        }
        return mapIntention(
          accountId,
          await this.get<Intention>("/connect/intentions/exact", {
            source: source!,
            destination: destination!,
          }),
        );
      }
      case "consul-config-entry": {
        const [kind, name, ns] = splitId(id, 2);
        return mapConfigEntry(
          accountId,
          await this.get<ConfigEntry>(
            `/config/${encodeURIComponent(kind!)}/${encodeURIComponent(name!)}`,
            ns ? { ns } : undefined,
          ),
        );
      }
      case "consul-acl-policy":
        return mapPolicy(
          accountId,
          await this.get<AclPolicy>(`/acl/policy/${encodeURIComponent(id)}`),
        );
      case "consul-acl-role":
        return mapRole(accountId, await this.get<AclRole>(`/acl/role/${encodeURIComponent(id)}`));
      case "consul-acl-token":
        return mapToken(
          accountId,
          await this.get<AclToken>(`/acl/token/${encodeURIComponent(id)}`),
        );
      case "consul-session": {
        const rows = await this.get<Session[] | null>(`/session/info/${encodeURIComponent(id)}`);
        if (!rows?.[0])
          throw new ConsulApiError(404, "Consul plugin: the session no longer exists");
        return mapSession(accountId, rows[0]);
      }
      case "consul-peering": {
        const [name] = splitId(id, 1);
        return mapPeering(
          accountId,
          await this.get<Peering>(`/peering/${encodeURIComponent(name!)}`),
        );
      }
      case "consul-namespace": {
        const [name] = splitId(id, 1);
        return this.mapNamespace(
          accountId,
          await this.get(`/namespace/${encodeURIComponent(name!)}`),
        );
      }
      case "consul-partition": {
        const [name] = splitId(id, 1);
        const p = await this.get<{ Name?: string; Description?: string }>(
          `/partition/${encodeURIComponent(name!)}`,
        );
        return instance(
          accountId,
          "consul-partition",
          id,
          p.Name ?? "",
          { name: p.Name, description: p.Description },
          { resolvedOutputs: { name: p.Name ?? "" } },
        );
      }
      case "consul-check": {
        const [node, checkId] = splitId(id, 2);
        const c = (
          (await this.get<Check[]>(`/health/node/${encodeURIComponent(node!)}`)) ?? []
        ).find((x) => x.CheckID === checkId);
        if (!c) throw new ConsulApiError(404, "Consul plugin: check not found");
        return mapCheck(accountId, c);
      }
      default:
        throw new ConsulApiError(404, `Consul plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const id = externalIdOf(resourceId);
    if (typeId === "consul-acl-token" && outputKey === "secretId")
      return (await this.get<AclToken>(`/acl/token/${encodeURIComponent(id)}`)).SecretID ?? "";
    if (typeId === "consul-acl-policy" && outputKey === "rules")
      return (await this.get<AclPolicy>(`/acl/policy/${encodeURIComponent(id)}`)).Rules ?? "";
    const r = await this.getResource(typeId, resourceId, accountId);
    return String(r.resolvedOutputs[outputKey] ?? r.fields[outputKey] ?? "");
  }

  /** Service instances with their health; node services. */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const id = resource.externalId ?? externalIdOf(resource.id);
    const extra: Record<string, string> = {};
    try {
      if (resource.resourceTypeId === "consul-service") {
        const [name, ns] = splitId(id, 1);
        const rows = await this.get<
          Array<{
            Node?: { Node?: string; Address?: string };
            Service?: { ID?: string; Address?: string; Port?: number; Tags?: string[] };
            Checks?: Check[];
          }>
        >(`/health/service/${encodeURIComponent(name!)}`, ns ? { ns } : undefined);
        extra["__instances__"] = JSON.stringify(
          (rows ?? []).map((r) => {
            const worst = (r.Checks ?? []).some((c) => c.Status === "critical")
              ? "critical"
              : (r.Checks ?? []).some((c) => c.Status === "warning")
                ? "warning"
                : "passing";
            return {
              id: r.Service?.ID ?? "",
              node: r.Node?.Node ?? "",
              address: `${r.Service?.Address || r.Node?.Address || ""}:${r.Service?.Port ?? ""}`,
              tags: (r.Service?.Tags ?? []).join(", "),
              health: worst,
            };
          }),
        );
      } else if (resource.resourceTypeId === "consul-node") {
        const [name] = splitId(id, 1);
        const svc = await this.get<{
          Services?: Array<{ ID?: string; Service?: string; Port?: number; Tags?: string[] }>;
        } | null>(`/catalog/node-services/${encodeURIComponent(name!)}`);
        extra["__services__"] = JSON.stringify(
          (svc?.Services ?? []).map((s) => ({
            id: s.ID ?? "",
            service: s.Service ?? "",
            port: String(s.Port ?? ""),
            tags: (s.Tags ?? []).join(", "),
          })),
        );
      }
    } catch {
      return resource;
    }
    return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
  }

  // -------------------------------------------------------------------------
  // KV browser (on the cluster)
  // -------------------------------------------------------------------------

  async listKvKeys(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    params: { prefix?: string; cursor?: string; limit?: number } = {},
  ): Promise<KvListResult> {
    const prefix = params.prefix ?? "";
    const keys =
      (await this.get<string[] | null>(`/kv/${encodeKey(prefix)}`, { keys: true }).catch(
        (err: unknown) => {
          if (statusOf(err) === 404) return [];
          throw err;
        },
      )) ?? [];
    const start = Number(params.cursor ?? 0) || 0;
    const size = Math.min(Math.max(params.limit ?? KV_PAGE, 1), 1000);
    const page = keys.sort().slice(start, start + size);
    return {
      items: page.map((name) => ({ name })),
      ...(start + size < keys.length ? { nextCursor: String(start + size) } : {}),
    };
  }

  async getKvValue(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    key: string,
  ): Promise<string> {
    return consulFetch<string>(this.ctx, `/kv/${encodeKey(key)}`, {
      query: { raw: true },
      text: true,
    });
  }

  async putKvValue(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    key: string,
    value: string,
  ): Promise<void> {
    const ok = await consulFetch<boolean>(this.ctx, `/kv/${encodeKey(key)}`, {
      method: "PUT",
      raw: value,
    });
    if (ok === false)
      throw new ConsulApiError(
        409,
        "Consul plugin: the write was refused (the key is locked by a session)",
      );
  }

  async deleteKvKey(
    _typeId: string,
    _resourceId: string,
    _accountId: string,
    key: string,
  ): Promise<void> {
    await consulFetch(this.ctx, `/kv/${encodeKey(key)}`, { method: "DELETE" });
  }

  // -------------------------------------------------------------------------
  // Metrics, stats, preflight
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (typeId !== "consul-cluster" && typeId !== "consul-service") return [];
    const f = (await this.getResource(typeId, resourceId, accountId)).fields;
    const critical = Number(f[typeId === "consul-cluster" ? "criticalChecks" : "critical"] ?? 0);
    return [
      typeId === "consul-cluster"
        ? { label: "Services", value: String(f["services"] ?? "?") }
        : { label: "Instances", value: String(f["instances"] ?? "?") },
      {
        label: "Critical",
        value: String(critical),
        variant: critical ? "status-error" : "status-healthy",
      },
    ];
  }

  /** Point-in-time Raft and runtime gauges from `/agent/metrics`; the host builds the series. */
  async fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<MetricSeries[]> {
    const now = Date.now();
    const pt = (label: string, unit: string, value: number | undefined): MetricSeries[] =>
      typeof value === "number" && Number.isFinite(value)
        ? [{ label, unit, points: [{ timestamp: now, value }] }]
        : [];
    if (typeId === "consul-service") {
      const f = (await this.getResource(typeId, resourceId, accountId)).fields;
      return [
        ...pt("Instances", "count", f["instances"] as number | undefined),
        ...pt("Critical checks", "count", f["critical"] as number | undefined),
      ];
    }
    if (typeId !== "consul-cluster") return [];
    const m = await this.get<{
      Gauges?: Array<{ Name?: string; Value?: number }>;
      Samples?: Array<{ Name?: string; Mean?: number }>;
    }>("/agent/metrics");
    const gauges: Record<string, [string, string]> = {
      "consul.raft.leader.oldestLogAge": ["Oldest Raft log age", "ms"],
      "consul.autopilot.failure_tolerance": ["Failure tolerance", "count"],
      "consul.autopilot.healthy": ["Autopilot healthy", "bool"],
      "consul.catalog.service.count": ["Services", "count"],
      "consul.runtime.num_goroutines": ["Goroutines", "count"],
      "consul.runtime.alloc_bytes": ["Memory allocated", "bytes"],
      "consul.consul.members.clients": ["Client members", "count"],
      "consul.consul.members.servers": ["Server members", "count"],
      "consul.consul.state.nodes": ["Nodes", "count"],
      "consul.consul.state.services": ["Service instances", "count"],
      "consul.consul.state.kv_entries": ["KV entries", "count"],
    };
    const samples: Record<string, [string, string]> = {
      "consul.raft.commitTime": ["Raft commit time", "ms"],
      "consul.kvs.apply": ["KV apply time", "ms"],
      "consul.rpc.request": ["RPC requests", "count"],
    };
    const out: MetricSeries[] = [];
    for (const g of m?.Gauges ?? [])
      if (g.Name && gauges[g.Name])
        out.push(...pt(gauges[g.Name]![0], gauges[g.Name]![1], g.Value));
    for (const s of m?.Samples ?? [])
      if (s.Name && samples[s.Name])
        out.push(...pt(samples[s.Name]![0], samples[s.Name]![1], s.Mean));
    return out;
  }

  async verifyCredentials(): Promise<PreflightResult> {
    const checks = await Promise.all(
      PROBES.map(async (p): Promise<PreflightCapabilityCheck> => {
        try {
          await this.get(p.path, p.query);
          return { capabilityId: p.capability.id, status: "ok" };
        } catch (err) {
          const s = statusOf(err);
          const msg = err instanceof Error ? err.message : String(err);
          if (s === 404 && p.capability.id === "kv") return { capabilityId: "kv", status: "ok" };
          if (/ACL support disabled/i.test(msg))
            return { capabilityId: p.capability.id, status: "ok" };
          if (s === 403 || s === 401)
            return {
              capabilityId: p.capability.id,
              status: "missing",
              missingPermissions: p.capability.requiredPermissions,
            };
          return { capabilityId: p.capability.id, status: "unknown", message: msg };
        }
      }),
    );
    const self = await this.soft(this.get<AclToken>("/acl/token/self"));
    return {
      checks,
      ...(self?.AccessorID
        ? { identity: `${self.Description || self.AccessorID} (${self.AccessorID.slice(0, 8)})` }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  private async policyLinks(raw: string | undefined): Promise<Array<{ Name: string }>> {
    return list(raw).map((Name) => ({ Name }));
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "consul-intention": {
        const services = Object.keys(
          (await this.soft(this.get<Record<string, string[]>>("/catalog/services"))) ?? {},
        ).filter((s) => s !== "consul");
        const opts = [
          { id: "*", label: "* (every service)" },
          ...services.map((s) => ({ id: s, label: s })),
        ];
        return {
          fields: [
            {
              key: "source",
              label: "Source service",
              kind: "select",
              required: true,
              options: opts,
            },
            {
              key: "destination",
              label: "Destination service",
              kind: "select",
              required: true,
              options: opts,
            },
            {
              key: "action",
              label: "Action",
              kind: "select",
              required: true,
              defaultValue: "allow",
              options: [
                { id: "allow", label: "Allow" },
                { id: "deny", label: "Deny" },
              ],
            },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      }
      case "consul-config-entry":
        return {
          fields: [
            {
              key: "kind",
              label: "Kind",
              kind: "select",
              required: true,
              defaultValue: "service-defaults",
              options: CONFIG_KINDS.map((k) => ({ id: k, label: k })),
            },
            {
              key: "entry",
              label: "Entry (JSON)",
              kind: "code",
              codeLanguage: "json",
              required: true,
              defaultValue: configTemplate("service-defaults", "web"),
              description:
                "Kind and Name in the document are what Consul uses. Starter shown for service-defaults.",
            },
          ],
        };
      case "consul-acl-policy":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "web-read" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "rules",
              label: "Rules (HCL)",
              kind: "code",
              codeLanguage: "hcl",
              required: true,
              defaultValue: POLICY_TEMPLATE,
            },
            {
              key: "datacenters",
              label: "Datacenters",
              kind: "string-list",
              required: false,
              placeholder: "Empty: all",
            },
          ],
        };
      case "consul-acl-role":
      case "consul-acl-token": {
        const [policies, roles] = await Promise.all([
          this.optional(this.get<AclPolicy[]>("/acl/policies")).catch(() => [] as AclPolicy[]),
          typeId === "consul-acl-token"
            ? this.optional(this.get<AclRole[]>("/acl/roles")).catch(() => [] as AclRole[])
            : Promise.resolve([] as AclRole[]),
        ]);
        return {
          fields: [
            typeId === "consul-acl-role"
              ? { key: "name", label: "Name", kind: "text", required: true }
              : {
                  key: "description",
                  label: "Description",
                  kind: "text",
                  required: false,
                  placeholder: "ci-deployer",
                },
            ...(typeId === "consul-acl-role"
              ? [
                  {
                    key: "description",
                    label: "Description",
                    kind: "text" as const,
                    required: false,
                  },
                ]
              : []),
            {
              key: "policies",
              label: "Policies",
              kind: "policy-picker",
              required: false,
              options: policies.map((p) => ({
                id: p.Name ?? "",
                label: p.Name ?? "",
                ...(p.Description ? { description: p.Description } : {}),
              })),
            },
            ...(typeId === "consul-acl-token"
              ? [
                  {
                    key: "roles",
                    label: "Roles",
                    kind: "policy-picker" as const,
                    required: false,
                    options: roles.map((r) => ({ id: r.Name ?? "", label: r.Name ?? "" })),
                  },
                ]
              : []),
            {
              key: "serviceIdentities",
              label: "Service identities",
              kind: "string-list",
              required: false,
              placeholder: "web",
            },
            ...(typeId === "consul-acl-token"
              ? [
                  {
                    key: "local",
                    label: "Local to this datacenter",
                    kind: "select" as const,
                    required: false,
                    defaultValue: "false",
                    options: [
                      { id: "false", label: "No" },
                      { id: "true", label: "Yes" },
                    ],
                  },
                  {
                    key: "ttl",
                    label: "Expires after",
                    kind: "text" as const,
                    required: false,
                    placeholder: "720h (empty: never)",
                  },
                ]
              : []),
          ],
        };
      }
      case "consul-peering":
        return {
          fields: [
            {
              key: "name",
              label: "Peer name",
              kind: "text",
              required: true,
              placeholder: "cluster-02",
              description: "How this cluster refers to the other one.",
            },
            {
              key: "mode",
              label: "This cluster",
              kind: "select",
              required: true,
              defaultValue: "generate",
              options: [
                {
                  id: "generate",
                  label: "Generates a token",
                  description: "Give the token to the other cluster to establish the peering.",
                },
                {
                  id: "establish",
                  label: "Establishes with a token",
                  description: "Paste the token the other cluster generated.",
                },
              ],
            },
            {
              key: "token",
              label: "Peering token",
              kind: "text",
              multiline: true,
              required: false,
              showWhen: { fieldKey: "mode", fieldValue: "establish" },
            },
          ],
        };
      case "consul-namespace":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "meta",
              label: "Metadata",
              kind: "text",
              required: false,
              placeholder: "team=payments",
            },
          ],
        };
      case "consul-partition":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
          ],
        };
      default:
        throw new ConsulApiError(400, `Consul plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  private parseEntry(raw: string, kind?: string): ConfigEntry {
    let e: ConfigEntry;
    try {
      e = JSON.parse(raw) as ConfigEntry;
    } catch {
      throw new ConsulApiError(400, "Consul plugin: the config entry is not valid JSON");
    }
    if (!e || typeof e !== "object" || Array.isArray(e))
      throw new ConsulApiError(400, "Consul plugin: the config entry must be a JSON object");
    if (kind && !e.Kind) e.Kind = kind;
    if (!e.Kind || !e.Name)
      throw new ConsulApiError(400, "Consul plugin: the config entry needs Kind and Name");
    return e;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const text = (k: string) => (fields[k] ?? "").trim();
    const need = (k: string, what: string) => {
      const v = text(k);
      if (!v) throw new ConsulApiError(400, `Consul plugin: ${what} is required`);
      return v;
    };
    const ref = (ext: string) => `${accountId}:${typeId}:${ext}`;
    switch (typeId) {
      case "consul-intention": {
        const source = need("source", "a source service");
        const destination = need("destination", "a destination service");
        await this.put(
          "/connect/intentions/exact",
          {
            SourceType: "consul",
            Action: text("action") || "allow",
            Description: text("description"),
          },
          { source, destination },
        );
        return this.getResource(typeId, ref(joinId(source, destination)), accountId);
      }
      case "consul-config-entry": {
        const e = this.parseEntry(fields["entry"] ?? "", text("kind"));
        const ok = await this.put<boolean>("/config", e);
        if (ok === false)
          throw new ConsulApiError(409, "Consul plugin: Consul refused the config entry");
        return this.getResource(typeId, ref(joinId(e.Kind!, e.Name!)), accountId);
      }
      case "consul-acl-policy": {
        const p = await this.put<AclPolicy>("/acl/policy", {
          Name: need("name", "a name"),
          Description: text("description"),
          Rules: fields["rules"] ?? "",
          ...(list(fields["datacenters"]).length
            ? { Datacenters: list(fields["datacenters"]) }
            : {}),
        });
        return mapPolicy(accountId, p);
      }
      case "consul-acl-role": {
        const r = await this.put<AclRole>("/acl/role", {
          Name: need("name", "a name"),
          Description: text("description"),
          Policies: await this.policyLinks(pickerList(fields["policies"])),
          ServiceIdentities: list(fields["serviceIdentities"]).map((ServiceName) => ({
            ServiceName,
          })),
        });
        return mapRole(accountId, r);
      }
      case "consul-acl-token": {
        const t = await this.put<AclToken>("/acl/token", {
          Description: text("description"),
          Policies: await this.policyLinks(pickerList(fields["policies"])),
          Roles: list(pickerList(fields["roles"])).map((Name) => ({ Name })),
          ServiceIdentities: list(fields["serviceIdentities"]).map((ServiceName) => ({
            ServiceName,
          })),
          Local: text("local") === "true",
          ...(text("ttl") ? { ExpirationTTL: text("ttl") } : {}),
        });
        const r = mapToken(accountId, t);
        return t.SecretID
          ? {
              ...r,
              secretStates: [
                { fieldKey: "secretId", resolution: { kind: "plaintext", value: t.SecretID } },
              ],
            }
          : r;
      }
      case "consul-peering": {
        const name = need("name", "a peer name");
        if (text("mode") === "establish") {
          await this.post("/peering/establish", {
            PeerName: name,
            PeeringToken: need("token", "the peering token"),
          });
          return this.getResource(typeId, ref(joinId(name)), accountId);
        }
        const res = await this.post<{ PeeringToken?: string }>("/peering/token", {
          PeerName: name,
        });
        const r = await this.getResource(typeId, ref(joinId(name)), accountId).catch(() =>
          instance(accountId, typeId, joinId(name), name, { name, state: "PENDING" }),
        );
        return res?.PeeringToken
          ? {
              ...r,
              resolvedOutputs: { ...r.resolvedOutputs, peeringToken: res.PeeringToken },
              secretStates: [
                {
                  fieldKey: "peeringToken",
                  resolution: { kind: "plaintext", value: res.PeeringToken },
                },
              ],
            }
          : r;
      }
      case "consul-namespace": {
        const name = need("name", "a name");
        await this.put("/namespace", {
          Name: name,
          Description: text("description"),
          Meta: parseMeta(fields["meta"]),
        });
        return this.getResource(typeId, ref(joinId(name)), accountId);
      }
      case "consul-partition": {
        const name = need("name", "a name");
        await this.put("/partition", { Name: name, Description: text("description") });
        return this.getResource(typeId, ref(joinId(name)), accountId);
      }
      default:
        throw new ConsulApiError(400, `Consul plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return consulFetch<T>(this.ctx, path, { method: "POST", body });
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
      case "consul-intention": {
        const [source, destination] = splitId(id, 2);
        if (source!.startsWith("peer:"))
          throw new ConsulApiError(
            400,
            "Consul plugin: intentions from a peer are edited in the service-intentions config entry",
          );
        const cur = await this.get<Intention>("/connect/intentions/exact", {
          source: source!,
          destination: destination!,
        });
        const l7 = (cur.Permissions ?? []).length > 0;
        if (l7 && has("action") && text("action"))
          throw new ConsulApiError(
            400,
            "Consul plugin: this is an L7 intention; change its permissions in the service-intentions config entry",
          );
        await this.put(
          "/connect/intentions/exact",
          {
            SourceType: cur.SourceType || "consul",
            ...(l7
              ? { Permissions: cur.Permissions }
              : { Action: has("action") ? text("action") : cur.Action }),
            Description: has("description") ? text("description") : (cur.Description ?? ""),
          },
          { source: source!, destination: destination! },
        );
        break;
      }
      case "consul-acl-policy": {
        const cur = await this.get<AclPolicy>(`/acl/policy/${encodeURIComponent(id)}`);
        await this.put(`/acl/policy/${encodeURIComponent(id)}`, {
          ID: id,
          Name: has("name") ? text("name") : cur.Name,
          Description: has("description") ? text("description") : cur.Description,
          Rules: has("rules") ? (fields["rules"] ?? "") : cur.Rules,
          Datacenters: has("datacenters") ? list(fields["datacenters"]) : (cur.Datacenters ?? []),
        });
        break;
      }
      case "consul-acl-role": {
        const cur = await this.get<AclRole>(`/acl/role/${encodeURIComponent(id)}`);
        await this.put(`/acl/role/${encodeURIComponent(id)}`, {
          ...cur,
          ID: id,
          Name: has("name") ? text("name") : cur.Name,
          Description: has("description") ? text("description") : cur.Description,
          Policies: has("policies")
            ? await this.policyLinks(pickerList(fields["policies"]))
            : cur.Policies,
          ServiceIdentities: has("serviceIdentities")
            ? list(fields["serviceIdentities"]).map((ServiceName) => ({ ServiceName }))
            : cur.ServiceIdentities,
        });
        break;
      }
      case "consul-acl-token": {
        const cur = await this.get<AclToken>(`/acl/token/${encodeURIComponent(id)}`);
        await this.put(`/acl/token/${encodeURIComponent(id)}`, {
          AccessorID: id,
          Description: has("description") ? text("description") : cur.Description,
          Policies: has("policies")
            ? await this.policyLinks(pickerList(fields["policies"]))
            : cur.Policies,
          Roles: has("roles")
            ? list(pickerList(fields["roles"])).map((Name) => ({ Name }))
            : cur.Roles,
          ServiceIdentities: has("serviceIdentities")
            ? list(fields["serviceIdentities"]).map((ServiceName) => ({ ServiceName }))
            : cur.ServiceIdentities,
          NodeIdentities: cur.NodeIdentities,
          Local: cur.Local,
        });
        break;
      }
      case "consul-namespace": {
        const [name] = splitId(id, 1);
        const cur = await this.get<{ Description?: string; Meta?: Record<string, string> }>(
          `/namespace/${encodeURIComponent(name!)}`,
        );
        await this.put(`/namespace/${encodeURIComponent(name!)}`, {
          ...cur,
          Name: name,
          Description: has("description") ? text("description") : cur.Description,
          Meta: has("meta") ? parseMeta(fields["meta"]) : cur.Meta,
        });
        break;
      }
      case "consul-partition": {
        const [name] = splitId(id, 1);
        await this.put(`/partition/${encodeURIComponent(name!)}`, {
          Name: name,
          Description: text("description"),
        });
        break;
      }
      default:
        throw new ConsulApiError(
          400,
          `Consul plugin: "${typeId}" cannot be edited from Infrawrench`,
        );
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const del = (path: string, query?: Query) =>
      consulFetch(this.ctx, path, { method: "DELETE", ...(query ? { query } : {}) });
    switch (typeId) {
      case "consul-node": {
        const [name] = splitId(id, 1);
        await this.put("/catalog/deregister", {
          Node: name,
          ...(this.ctx.datacenter ? { Datacenter: this.ctx.datacenter } : {}),
        });
        return;
      }
      case "consul-intention": {
        const [source, destination] = splitId(id, 2);
        if (source!.startsWith("peer:"))
          throw new ConsulApiError(
            400,
            "Consul plugin: intentions from a peer are removed in the service-intentions config entry",
          );
        await del("/connect/intentions/exact", { source: source!, destination: destination! });
        return;
      }
      case "consul-config-entry": {
        const [kind, name, ns] = splitId(id, 2);
        await del(
          `/config/${encodeURIComponent(kind!)}/${encodeURIComponent(name!)}`,
          ns ? { ns } : undefined,
        );
        return;
      }
      case "consul-acl-policy":
        if (id === "00000000-0000-0000-0000-000000000001")
          throw new ConsulApiError(400, "Consul plugin: global-management is built in");
        await del(`/acl/policy/${encodeURIComponent(id)}`);
        return;
      case "consul-acl-role":
        await del(`/acl/role/${encodeURIComponent(id)}`);
        return;
      case "consul-acl-token": {
        if (BUILTIN_TOKENS.has(id))
          throw new ConsulApiError(400, "Consul plugin: the anonymous token cannot be deleted");
        const self = await this.soft(this.get<AclToken>("/acl/token/self"));
        if (self?.AccessorID === id)
          throw new ConsulApiError(
            400,
            "Consul plugin: refusing to delete the token this connection uses",
          );
        await del(`/acl/token/${encodeURIComponent(id)}`);
        return;
      }
      case "consul-session":
        await this.put(`/session/destroy/${encodeURIComponent(id)}`, undefined);
        return;
      case "consul-peering":
        await del(`/peering/${encodeURIComponent(splitId(id, 1)[0]!)}`);
        return;
      case "consul-namespace":
        if (splitId(id, 1)[0] === "default")
          throw new ConsulApiError(400, "Consul plugin: the default namespace cannot be deleted");
        await del(`/namespace/${encodeURIComponent(splitId(id, 1)[0]!)}`);
        return;
      case "consul-partition":
        if (splitId(id, 1)[0] === "default")
          throw new ConsulApiError(400, "Consul plugin: the default partition cannot be deleted");
        await del(`/partition/${encodeURIComponent(splitId(id, 1)[0]!)}`);
        return;
      default:
        throw new ConsulApiError(
          400,
          `Consul plugin: "${typeId}" cannot be deleted from Infrawrench`,
        );
    }
  }

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    if (typeId === "consul-session" && actionId === "renew") {
      await this.put(`/session/renew/${encodeURIComponent(id)}`, undefined);
      return;
    }
    throw new ConsulApiError(400, `Consul plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const v = decodePromptArgs(args);
    if (typeId === "consul-acl-policy" && command === COMMANDS.editRules) {
      await this.updateResource(typeId, resourceId, accountId, { rules: v["rules"] ?? "" });
      return { ok: true };
    }
    throw new ConsulApiError(400, `Consul plugin: unknown command "${command}"`);
  }

  /** Config entries: the full entry as JSON; edits are applied with check-and-set on its ModifyIndex. */
  async getManifest(resourceId: string): Promise<string> {
    const [kind, name, ns] = splitId(externalIdOf(resourceId), 2);
    const e = await this.get<ConfigEntry>(
      `/config/${encodeURIComponent(kind!)}/${encodeURIComponent(name!)}`,
      ns ? { ns } : undefined,
    );
    const {
      CreateIndex: _c,
      ModifyIndex: _m,
      Hash: _h,
      ...rest
    } = e as ConfigEntry & { CreateIndex?: number; Hash?: string };
    return JSON.stringify(rest, null, 2);
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const [kind, name, ns] = splitId(externalIdOf(resourceId), 2);
    const e = this.parseEntry(manifest, kind);
    if (e.Kind !== kind || e.Name !== name)
      throw new ConsulApiError(
        400,
        `Consul plugin: Kind and Name must stay ${kind}/${name}; create a new entry instead`,
      );
    const cur = await this.get<ConfigEntry>(
      `/config/${encodeURIComponent(kind!)}/${encodeURIComponent(name!)}`,
      ns ? { ns } : undefined,
    );
    const ok = await this.put<boolean>("/config", e, {
      ...(cur.ModifyIndex ? { cas: cur.ModifyIndex } : {}),
      ...(ns ? { ns } : {}),
    });
    if (ok === false)
      throw new ConsulApiError(
        409,
        "Consul plugin: the entry changed since it was opened; reload and try again",
      );
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderConsulDetail(resource, this.ctx.address);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderConsulSidebar(resource);
  }
}

/** A policy-picker answers a JSON array; text fields a comma list. Normalised to a comma list. */
export function pickerList(raw: string | undefined): string {
  const t = (raw ?? "").trim();
  if (t.startsWith("[")) {
    try {
      return (JSON.parse(t) as unknown[]).map(String).join(",");
    } catch {
      // fall through
    }
  }
  return t;
}
