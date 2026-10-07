import type {
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PreflightCapability,
  PreflightCapabilityCheck,
  PreflightResult,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { decodePromptArgs, externalIdOf, utf8ToBase64 } from "@infrawrench/plugin-base";
import type { NomadContext, Query } from "./api.js";
import {
  buildContext,
  encodePath,
  joinId,
  NomadApiError,
  nomadFetch,
  splitId,
  statusOf,
} from "./api.js";
import type {
  AclToken,
  AllocStub,
  CsiPlugin,
  Deployment,
  JobStub,
  NodeStub,
  Variable,
  Volume,
} from "./mappers.js";
import {
  mapAllocation,
  mapCsiPlugin,
  mapDeployment,
  mapJob,
  mapNode,
  mapService,
  mapToken,
  mapVariable,
  mapVolume,
  metaText,
  parseMeta,
} from "./mappers.js";
import { COMMANDS, renderNomadDetail, renderNomadSidebar } from "./render.js";

const MAX_JOBS = 3000;
const MAX_ALLOCS = 3000;
const MAX_DEPLOYMENTS = 500;
const ALL = { namespace: "*" } as const;

export const JOB_TEMPLATE = `job "example" {
  type = "service"

  group "web" {
    count = 1

    network {
      port "http" { to = 8080 }
    }

    task "server" {
      driver = "docker"

      config {
        image = "hashicorp/http-echo:1.0"
        args  = ["-listen", ":8080", "-text", "hello"]
        ports = ["http"]
      }

      resources {
        cpu    = 100
        memory = 64
      }
    }
  }
}
`;

const POLICY_TEMPLATE = `namespace "default" {
  policy = "read"
}

node {
  policy = "read"
}
`;

export function parseItems(raw: string): Record<string, string> {
  const t = raw.trim();
  if (!t) return {};
  if (t.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      throw new NomadApiError(400, "Nomad plugin: the items are not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new NomadApiError(400, "Nomad plugin: the items must be a JSON object");
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === "string" ? v : JSON.stringify(v),
      ]),
    );
  }
  const out: Record<string, string> = {};
  for (const line of t.split(/\r?\n/)) {
    const m = /^\s*([^=#\s][^=]*?)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

const DURATION_NS: Record<string, number> = { s: 1e9, m: 60e9, h: 3600e9, d: 86_400e9 };
export function durationNs(raw: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(raw.trim());
  if (!m) throw new NomadApiError(400, `Nomad plugin: "${raw}" is not a duration like 30m or 1h`);
  return Number(m[1]) * DURATION_NS[m[2]!]!;
}

const PROBES: Array<{ capability: PreflightCapability; path: string; query?: Query }> = [
  {
    capability: {
      id: "jobs",
      label: "Jobs and allocations",
      description: "List, run, stop and scale jobs; read allocations, logs and deployments.",
      requiredPermissions: [{ id: 'namespace "*" { policy = "write" }', label: "namespace write" }],
      essential: true,
    },
    path: "/jobs",
    query: ALL,
  },
  {
    capability: {
      id: "nodes",
      label: "Nodes",
      description: "Read nodes; drain them and change their eligibility (node write).",
      requiredPermissions: [{ id: 'node { policy = "write" }', label: "node write" }],
    },
    path: "/nodes",
  },
  {
    capability: {
      id: "variables",
      label: "Variables",
      description: "List, read and write variables.",
      requiredPermissions: [
        {
          id: 'namespace "*" { variables { path "*" { capabilities = ["write", "read", "list", "destroy"] } } }',
          label: "variables",
        },
      ],
    },
    path: "/vars",
    query: ALL,
  },
  {
    capability: {
      id: "acl",
      label: "ACL policies and tokens",
      description: "Manage ACL policies and tokens (needs a management token).",
      requiredPermissions: [{ id: "management", label: "Management token" }],
    },
    path: "/acl/tokens",
  },
  {
    capability: {
      id: "agent",
      label: "Agent and metrics",
      description: "Read the agent's configuration, cluster members and telemetry.",
      requiredPermissions: [{ id: 'agent { policy = "read" }', label: "agent read" }],
    },
    path: "/agent/self",
  },
];

export const NOMAD_PREFLIGHT = { capabilities: PROBES.map((p) => p.capability) };

interface AgentSelf {
  config?: {
    Region?: string;
    Datacenter?: string;
    ACL?: { Enabled?: boolean };
    Version?: { Version?: string };
  };
  member?: { Tags?: Record<string, string> };
}

export class NomadClient implements PluginClient {
  private readonly ctx: NomadContext;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    this.ctx = buildContext(credentials, services?.http);
  }

  private get<T>(path: string, query?: Query): Promise<T> {
    return nomadFetch<T>(this.ctx, path, query ? { query } : {});
  }

  private post<T>(path: string, body: unknown, query?: Query): Promise<T> {
    return nomadFetch<T>(this.ctx, path, { method: "POST", body, ...(query ? { query } : {}) });
  }

  private soft<T>(p: Promise<T>): Promise<T | undefined> {
    return p.catch(() => undefined);
  }

  /** A list that is empty rather than failing when ACL support is off or the feature is absent. */
  private async optional<T>(p: Promise<T[]>): Promise<T[]> {
    try {
      return (await p) ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (
        statusOf(err) === 404 ||
        (statusOf(err) === 400 && /ACL support disabled|unknown volume type/i.test(msg))
      )
        return [];
      throw err;
    }
  }

  private async cluster(accountId: string): Promise<ResourceInstance> {
    const [leader, peers, self, members, regions, nodes, jobs] = await Promise.all([
      this.get<string>("/status/leader"),
      this.soft(this.get<string[]>("/status/peers")),
      this.soft(this.get<AgentSelf>("/agent/self")),
      this.soft(this.get<{ Members?: Array<{ Name?: string }> }>("/agent/members")),
      this.soft(this.get<string[]>("/regions")),
      this.soft(this.get<NodeStub[]>("/nodes")),
      this.soft(this.get<JobStub[]>("/jobs", ALL)),
    ]);
    const now = new Date().toISOString();
    const fields: Record<string, string | number | boolean> = {
      address: this.ctx.address,
      leader: leader ?? "",
    };
    const set = (k: string, v: string | number | boolean | undefined) => {
      if (v !== undefined && v !== "") fields[k] = v;
    };
    set("version", self?.config?.Version?.Version ?? self?.member?.Tags?.["build"]);
    set("region", self?.config?.Region ?? this.ctx.region);
    set("datacenter", self?.config?.Datacenter);
    set("raftPeers", peers?.length);
    set("servers", members?.Members?.length);
    set("regions", regions?.join(", "));
    set("aclEnabled", self?.config?.ACL?.Enabled);
    set("nodes", nodes?.length);
    set("nodesReady", nodes?.filter((n) => n.Status === "ready").length);
    set("jobs", jobs?.length);
    set("jobsRunning", jobs?.filter((j) => j.Status === "running").length);
    set("jobsPending", jobs?.filter((j) => j.Status === "pending").length);
    const host = (() => {
      try {
        return new URL(this.ctx.address).host;
      } catch {
        return this.ctx.address;
      }
    })();
    return {
      id: `${accountId}:nomad-cluster:cluster`,
      pluginId: "nomad",
      resourceTypeId: "nomad-cluster",
      accountId,
      displayName: `${String(fields["region"] ?? "nomad")} · ${host}`,
      fields,
      resolvedOutputs: { address: this.ctx.address, region: String(fields["region"] ?? "") },
      secretStates: [],
      externalId: "cluster",
      createdAt: now,
      updatedAt: now,
    };
  }

  private async variables(): Promise<Variable[]> {
    return this.get<Variable[]>("/vars", ALL).then((v) => v ?? []);
  }

  private variable(ns: string, path: string): Promise<Variable> {
    return this.get<Variable>(`/var/${encodePath(path)}`, { namespace: ns });
  }

  private job(ns: string, id: string): Promise<JobStub & Record<string, unknown>> {
    return this.get(`/job/${encodeURIComponent(id)}`, { namespace: ns });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "nomad-cluster":
        return [await this.cluster(accountId)];
      case "nomad-namespace":
        return (
          await this.get<
            Array<{
              Name?: string;
              Description?: string;
              Quota?: string;
              Meta?: Record<string, string>;
            }>
          >("/namespaces")
        ).map((n) => this.mapNamespace(accountId, n));
      case "nomad-node-pool": {
        const [pools, nodes] = await Promise.all([
          this.get<
            Array<{
              Name?: string;
              Description?: string;
              Meta?: Record<string, string>;
              SchedulerConfiguration?: { SchedulerAlgorithm?: string };
            }>
          >("/node/pools"),
          this.soft(this.get<NodeStub[]>("/nodes")),
        ]);
        return pools.map((p) =>
          this.mapPool(accountId, p, nodes?.filter((n) => n.NodePool === p.Name).length),
        );
      }
      case "nomad-node":
        return (await this.get<NodeStub[]>("/nodes", { resources: true })).map((n) =>
          mapNode(accountId, n),
        );
      case "nomad-job":
        return (await this.get<JobStub[]>("/jobs", ALL))
          .slice(0, MAX_JOBS)
          .map((j) => mapJob(accountId, j));
      case "nomad-allocation": {
        const allocs =
          (await this.get<AllocStub[]>("/allocations", { ...ALL, resources: false })) ?? [];
        const live = (a: AllocStub) =>
          a.ClientStatus === "running" || a.ClientStatus === "pending" ? 1 : 0;
        return allocs
          .sort((a, b) => live(b) - live(a) || (b.ModifyTime ?? 0) - (a.ModifyTime ?? 0))
          .slice(0, MAX_ALLOCS)
          .map((a) => mapAllocation(accountId, a));
      }
      case "nomad-deployment":
        return ((await this.get<Deployment[]>("/deployments", ALL)) ?? [])
          .slice(0, MAX_DEPLOYMENTS)
          .map((d) => mapDeployment(accountId, d));
      case "nomad-variable":
        return (await this.variables()).map((v) => mapVariable(accountId, v));
      case "nomad-acl-policy": {
        // The list omits the rules; read them (policies are few) so Terraform export has them.
        const list = await this.optional(
          this.get<Array<{ Name?: string; Description?: string }>>("/acl/policies"),
        );
        return Promise.all(
          list
            .slice(0, 200)
            .map(async (p) =>
              this.mapPolicy(
                accountId,
                (await this.soft(
                  this.get<{ Name?: string; Description?: string; Rules?: string }>(
                    `/acl/policy/${encodeURIComponent(p.Name ?? "")}`,
                  ),
                )) ?? p,
              ),
            ),
        );
      }
      case "nomad-acl-token":
        return (await this.optional(this.get<AclToken[]>("/acl/tokens"))).map((t) =>
          mapToken(accountId, t),
        );
      case "nomad-volume": {
        const [csi, host] = await Promise.all([
          this.optional(this.get<Volume[]>("/volumes", { ...ALL, type: "csi" })),
          this.optional(this.get<Volume[]>("/volumes", { ...ALL, type: "host" })),
        ]);
        return [
          ...csi.map((v) => mapVolume(accountId, v, "csi")),
          ...host.map((v) => mapVolume(accountId, v, "host")),
        ];
      }
      case "nomad-csi-plugin":
        return (await this.optional(this.get<CsiPlugin[]>("/plugins", { type: "csi" }))).map((p) =>
          mapCsiPlugin(accountId, p),
        );
      case "nomad-service": {
        const groups =
          (await this.get<
            Array<{
              Namespace?: string;
              Services?: Array<{ ServiceName?: string; Tags?: string[] }>;
            }>
          >("/services", ALL)) ?? [];
        return groups.flatMap((g) =>
          (g.Services ?? []).map((s) =>
            mapService(accountId, g.Namespace ?? "default", s.ServiceName ?? "", s.Tags ?? []),
          ),
        );
      }
      default:
        return [];
    }
  }

  private mapNamespace(
    accountId: string,
    n: { Name?: string; Description?: string; Quota?: string; Meta?: Record<string, string> },
  ): ResourceInstance {
    const now = new Date().toISOString();
    const name = n.Name ?? "";
    return {
      id: `${accountId}:nomad-namespace:${encodeURIComponent(name)}`,
      pluginId: "nomad",
      resourceTypeId: "nomad-namespace",
      accountId,
      displayName: name,
      fields: {
        name,
        description: n.Description ?? "",
        quota: n.Quota ?? "",
        meta: metaText(n.Meta),
      },
      resolvedOutputs: { name },
      secretStates: [],
      externalId: encodeURIComponent(name),
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapPool(
    accountId: string,
    p: {
      Name?: string;
      Description?: string;
      Meta?: Record<string, string>;
      SchedulerConfiguration?: { SchedulerAlgorithm?: string };
    },
    nodes: number | undefined,
  ): ResourceInstance {
    const now = new Date().toISOString();
    const name = p.Name ?? "";
    return {
      id: `${accountId}:nomad-node-pool:${encodeURIComponent(name)}`,
      pluginId: "nomad",
      resourceTypeId: "nomad-node-pool",
      accountId,
      displayName: name,
      fields: {
        name,
        description: p.Description ?? "",
        schedulerAlgorithm: p.SchedulerConfiguration?.SchedulerAlgorithm ?? "",
        meta: metaText(p.Meta),
        ...(nodes !== undefined ? { nodes } : {}),
      },
      resolvedOutputs: { name },
      secretStates: [],
      externalId: encodeURIComponent(name),
      createdAt: now,
      updatedAt: now,
    };
  }

  private mapPolicy(
    accountId: string,
    p: { Name?: string; Description?: string; Rules?: string },
  ): ResourceInstance {
    const now = new Date().toISOString();
    const name = p.Name ?? "";
    return {
      id: `${accountId}:nomad-acl-policy:${encodeURIComponent(name)}`,
      pluginId: "nomad",
      resourceTypeId: "nomad-acl-policy",
      accountId,
      displayName: name,
      fields: { name, description: p.Description ?? "" },
      resolvedOutputs: { name, ...(p.Rules !== undefined ? { rules: p.Rules } : {}) },
      secretStates: [],
      externalId: encodeURIComponent(name),
      createdAt: now,
      updatedAt: now,
    };
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "nomad-cluster":
        return this.cluster(accountId);
      case "nomad-namespace":
        return this.mapNamespace(accountId, await this.get(`/namespace/${id}`));
      case "nomad-node-pool": {
        const [p, nodes] = await Promise.all([
          this.get<{ Name?: string }>(`/node/pool/${id}`),
          this.soft(this.get<NodeStub[]>(`/node/pool/${id}/nodes`)),
        ]);
        return this.mapPool(accountId, p, nodes?.length);
      }
      case "nomad-node": {
        const [n, allocs] = await Promise.all([
          this.get<NodeStub>(`/node/${encodeURIComponent(id)}`),
          this.soft(this.get<AllocStub[]>(`/node/${encodeURIComponent(id)}/allocations`)),
        ]);
        return mapNode(accountId, n, allocs?.filter((a) => a.ClientStatus === "running").length);
      }
      case "nomad-job": {
        const [ns, jobId] = splitId(id, 2);
        const [job, summary] = await Promise.all([
          this.job(ns!, jobId!),
          this.soft(
            this.get<JobStub["JobSummary"]>(`/job/${encodeURIComponent(jobId!)}/summary`, {
              namespace: ns!,
            }),
          ),
        ]);
        return mapJob(accountId, { ...job, ...(summary ? { JobSummary: summary } : {}) });
      }
      case "nomad-allocation":
        return mapAllocation(
          accountId,
          await this.get<AllocStub>(`/allocation/${encodeURIComponent(id)}`),
        );
      case "nomad-deployment":
        return mapDeployment(
          accountId,
          await this.get<Deployment>(`/deployment/${encodeURIComponent(id)}`),
        );
      case "nomad-variable": {
        const [ns, path] = splitId(id, 2);
        return mapVariable(accountId, await this.variable(ns!, path!));
      }
      case "nomad-acl-policy":
        return this.mapPolicy(accountId, await this.get(`/acl/policy/${id}`));
      case "nomad-acl-token":
        return mapToken(
          accountId,
          await this.get<AclToken>(`/acl/token/${encodeURIComponent(id)}`),
        );
      case "nomad-volume": {
        const [type, ns, volId] = splitId(id, 3);
        return mapVolume(
          accountId,
          await this.get<Volume>(`/volume/${type}/${encodeURIComponent(volId!)}`, {
            namespace: ns!,
          }),
          type as "csi" | "host",
        );
      }
      case "nomad-csi-plugin":
        return mapCsiPlugin(
          accountId,
          await this.get<CsiPlugin>(`/plugin/csi/${encodeURIComponent(id)}`),
        );
      case "nomad-service": {
        const [ns, name] = splitId(id, 2);
        const regs = await this.get<Array<{ Tags?: string[] }>>(
          `/service/${encodeURIComponent(name!)}`,
          { namespace: ns! },
        );
        return mapService(
          accountId,
          ns!,
          name!,
          [...new Set((regs ?? []).flatMap((r) => r.Tags ?? []))],
          regs?.length ?? 0,
        );
      }
      default:
        throw new NomadApiError(404, `Nomad plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const id = externalIdOf(resourceId);
    if (typeId === "nomad-acl-token" && outputKey === "secretId") {
      return (await this.get<AclToken>(`/acl/token/${encodeURIComponent(id)}`)).SecretID ?? "";
    }
    if (typeId === "nomad-variable" && outputKey === "items") {
      const [ns, path] = splitId(id, 2);
      return JSON.stringify((await this.variable(ns!, path!)).Items ?? {});
    }
    if (typeId === "nomad-acl-policy" && outputKey === "rules") {
      return (await this.get<{ Rules?: string }>(`/acl/policy/${id}`)).Rules ?? "";
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    return String(r.resolvedOutputs[outputKey] ?? r.fields[outputKey] ?? "");
  }

  /** Versions and groups for job prompts, service registrations, policy rules. */
  async enrichDetail(resource: ResourceInstance): Promise<ResourceInstance> {
    const id = resource.externalId ?? externalIdOf(resource.id);
    const extra: Record<string, string> = {};
    try {
      if (resource.resourceTypeId === "nomad-job") {
        const [ns, jobId] = splitId(id, 2);
        const [versions, job] = await Promise.all([
          this.get<{
            Versions?: Array<{ Version?: number; Stable?: boolean; SubmitTime?: number }>;
          }>(`/job/${encodeURIComponent(jobId!)}/versions`, { namespace: ns! }),
          this.job(ns!, jobId!),
        ]);
        extra["__versions__"] = JSON.stringify(
          (versions?.Versions ?? []).map((v) => ({
            version: v.Version ?? 0,
            stable: v.Stable === true,
          })),
        );
        extra["__groups__"] = JSON.stringify(
          (job.TaskGroups ?? []).map((g) => ({ name: g.Name ?? "", count: g.Count ?? 0 })),
        );
      } else if (resource.resourceTypeId === "nomad-service") {
        const [ns, name] = splitId(id, 2);
        const regs = await this.get<
          Array<{
            Address?: string;
            Port?: number;
            AllocID?: string;
            NodeID?: string;
            JobID?: string;
            Datacenter?: string;
          }>
        >(`/service/${encodeURIComponent(name!)}`, { namespace: ns! });
        extra["__registrations__"] = JSON.stringify(
          (regs ?? []).map((r) => ({
            address: `${r.Address ?? ""}:${r.Port ?? ""}`,
            job: r.JobID ?? "",
            alloc: (r.AllocID ?? "").slice(0, 8),
            node: (r.NodeID ?? "").slice(0, 8),
            dc: r.Datacenter ?? "",
          })),
        );
      } else if (resource.resourceTypeId === "nomad-acl-policy") {
        extra["rules"] = (await this.get<{ Rules?: string }>(`/acl/policy/${id}`)).Rules ?? "";
      }
      if (resource.resourceTypeId === "nomad-acl-token") {
        const policies = await this.soft(this.get<Array<{ Name?: string }>>("/acl/policies"));
        if (policies) extra["__policies__"] = JSON.stringify(policies.map((p) => p.Name ?? ""));
      }
    } catch {
      return resource;
    }
    return { ...resource, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
  }

  // -------------------------------------------------------------------------
  // Logs, metrics, stats
  // -------------------------------------------------------------------------

  /**
   * Allocation task logs via `GET /client/fs/logs/:alloc?task&type&origin=end&offset&plain=true`
   * (the server forwards to the client node). Each task offers stdout and stderr.
   */
  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "nomad-allocation")
      throw new NomadApiError(400, "Nomad plugin: logs are per allocation");
    const id = externalIdOf(resourceId);
    const alloc = await this.get<AllocStub>(`/allocation/${encodeURIComponent(id)}`);
    const tasks = Object.keys(alloc.TaskStates ?? {}).sort();
    const containers = tasks.flatMap((t) => [`${t} (stdout)`, `${t} (stderr)`]);
    const active =
      params.container && containers.includes(params.container)
        ? params.container
        : (containers[0] ?? "");
    if (!active) return { text: "", containers, activeContainer: "" };
    const m = /^(.*) \((stdout|stderr)\)$/.exec(active)!;
    const tail = Math.max(1, Math.min(params.tailLines ?? 200, 5000));
    const text = await nomadFetch<string>(this.ctx, `/client/fs/logs/${encodeURIComponent(id)}`, {
      query: {
        task: m[1]!,
        type: m[2]!,
        origin: "end",
        offset: tail * 300,
        plain: true,
        follow: false,
      },
      text: true,
    }).catch((err: unknown) => {
      if (statusOf(err) === 404) return "";
      throw err;
    });
    const lines = text.split("\n");
    if (lines.length > tail + 1) lines.splice(0, lines.length - tail - 1);
    return { text: lines.join("\n"), containers, activeContainer: active };
  }

  async fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    if (!["nomad-cluster", "nomad-job", "nomad-node"].includes(typeId)) return [];
    const f = (await this.getResource(typeId, resourceId, accountId)).fields;
    if (typeId === "nomad-cluster")
      return [
        {
          label: "Nodes ready",
          value: `${String(f["nodesReady"] ?? "?")}/${String(f["nodes"] ?? "?")}`,
        },
        { label: "Jobs running", value: String(f["jobsRunning"] ?? "?") },
      ];
    if (typeId === "nomad-node")
      return [
        {
          label: "Status",
          value: String(f["status"] ?? "?"),
          variant: f["status"] === "ready" ? "status-healthy" : "status-error",
        },
      ];
    return [
      { label: "Running", value: String(f["running"] ?? 0) },
      {
        label: "Failed",
        value: String(f["failed"] ?? 0),
        variant: Number(f["failed"] ?? 0) ? "status-degraded" : "default",
      },
    ];
  }

  /** Point-in-time readings; Nomad keeps no metric history, so the host builds the series. */
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
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "nomad-cluster": {
        const m = await this.get<{ Gauges?: Array<{ Name?: string; Value?: number }> }>("/metrics");
        const wanted: Record<string, [string, string]> = {
          "nomad.broker.total_ready": ["Evaluations ready", "count"],
          "nomad.broker.total_unacked": ["Evaluations unacked", "count"],
          "nomad.blocked_evals.total_blocked": ["Blocked evaluations", "count"],
          "nomad.plan.queue_depth": ["Plan queue depth", "count"],
          "nomad.heartbeat.active": ["Active heartbeats", "count"],
          "runtime.num_goroutines": ["Goroutines", "count"],
          "runtime.alloc_bytes": ["Memory allocated", "bytes"],
        };
        const sums = new Map<string, number>();
        for (const g of m?.Gauges ?? []) {
          if (!g.Name || typeof g.Value !== "number") continue;
          const key = Object.keys(wanted).find((w) => g.Name === w || g.Name!.endsWith(`.${w}`));
          if (key) sums.set(key, (sums.get(key) ?? 0) + g.Value);
        }
        return [...sums].flatMap(([k, v]) => pt(wanted[k]![0], wanted[k]![1], v));
      }
      case "nomad-node": {
        const s = await this.get<{
          CPU?: Array<{ Total?: number }>;
          Memory?: { Used?: number; Total?: number };
          AllocDirStats?: { UsedPercent?: number };
        }>("/client/stats", { node_id: id });
        const cpus = s.CPU ?? [];
        return [
          ...pt(
            "CPU",
            "%",
            cpus.length ? cpus.reduce((a, c) => a + (c.Total ?? 0), 0) / cpus.length : undefined,
          ),
          ...pt("Memory used", "bytes", s.Memory?.Used),
          ...pt("Alloc dir used", "%", s.AllocDirStats?.UsedPercent),
        ];
      }
      case "nomad-allocation": {
        const s = await this.get<{
          ResourceUsage?: {
            CpuStats?: { Percent?: number };
            MemoryStats?: { RSS?: number; Usage?: number };
          };
        }>(`/client/allocation/${encodeURIComponent(id)}/stats`);
        return [
          ...pt("CPU", "%", s.ResourceUsage?.CpuStats?.Percent),
          ...pt(
            "Memory (RSS)",
            "bytes",
            s.ResourceUsage?.MemoryStats?.RSS || s.ResourceUsage?.MemoryStats?.Usage,
          ),
        ];
      }
      case "nomad-job": {
        const f = (await this.getResource(typeId, resourceId, accountId)).fields;
        return [
          ...pt("Running", "count", f["running"] as number | undefined),
          ...pt("Queued", "count", f["queued"] as number | undefined),
          ...pt("Failed", "count", f["failed"] as number | undefined),
        ];
      }
      default:
        return [];
    }
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
          if (s === 400 && /ACL support disabled/i.test(msg))
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
        ? { identity: `${self.Name || self.AccessorID} (${self.Type ?? "client"})` }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  private async namespacePicker(): Promise<CreateResourceConfig["fields"]> {
    const names = (await this.soft(this.get<Array<{ Name?: string }>>("/namespaces")))?.map(
      (n) => n.Name ?? "",
    ) ?? ["default"];
    return [
      {
        key: "namespace",
        label: "Namespace",
        kind: "select",
        required: true,
        defaultValue: names.includes("default") ? "default" : (names[0] ?? "default"),
        options: names.map((n) => ({ id: n, label: n })),
      },
    ];
  }

  async getCreateConfig(typeId: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "nomad-namespace":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "team-a" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "meta",
              label: "Metadata",
              kind: "text",
              required: false,
              placeholder: "owner=platform",
            },
          ],
        };
      case "nomad-node-pool":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "gpu" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "schedulerAlgorithm",
              label: "Scheduler algorithm",
              kind: "select",
              required: false,
              defaultValue: "",
              options: [
                { id: "", label: "Cluster default" },
                { id: "binpack", label: "Bin pack" },
                { id: "spread", label: "Spread" },
              ],
            },
          ],
        };
      case "nomad-job":
        return {
          fields: [
            ...(await this.namespacePicker()),
            {
              key: "jobspec",
              label: "Job specification (HCL)",
              kind: "code",
              codeLanguage: "hcl",
              required: true,
              defaultValue: JOB_TEMPLATE,
              description:
                "Parsed by the Nomad server, then registered. A namespace set in the file is replaced by the one picked here.",
            },
          ],
        };
      case "nomad-variable":
        return {
          fields: [
            ...(await this.namespacePicker()),
            {
              key: "path",
              label: "Path",
              kind: "text",
              required: true,
              placeholder: "nomad/jobs/web",
              description:
                "Letters, digits, - _ ~ and /. nomad/jobs/<job> is readable by that job automatically.",
            },
            {
              key: "items",
              label: "Items",
              kind: "text",
              multiline: true,
              required: true,
              placeholder: "DB_PASSWORD=…\nAPI_KEY=…  (or a JSON object)",
            },
          ],
        };
      case "nomad-acl-policy":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "readonly" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "rules",
              label: "Rules (HCL)",
              kind: "code",
              codeLanguage: "hcl",
              required: true,
              defaultValue: POLICY_TEMPLATE,
            },
          ],
        };
      case "nomad-acl-token": {
        const policies =
          (await this.soft(this.get<Array<{ Name?: string }>>("/acl/policies"))) ?? [];
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: false,
              placeholder: "ci-deployer",
            },
            {
              key: "type",
              label: "Type",
              kind: "select",
              required: true,
              defaultValue: "client",
              options: [
                { id: "client", label: "Client", description: "Limited to its policies." },
                {
                  id: "management",
                  label: "Management",
                  description: "Full access; ignores policies.",
                },
              ],
            },
            {
              key: "policies",
              label: "Policies",
              kind: "policy-picker",
              required: false,
              options: policies.map((p) => ({ id: p.Name ?? "", label: p.Name ?? "" })),
              showWhen: { fieldKey: "type", fieldValue: "client" },
            },
            {
              key: "global",
              label: "Global (replicated to every region)",
              kind: "select",
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
              kind: "text",
              required: false,
              placeholder: "720h (empty: never)",
            },
          ],
        };
      }
      default:
        throw new NomadApiError(400, `Nomad plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  /** HCL (parsed by the server) or JSON (bare job or `{Job: …}`) into a registered job. */
  private async register(spec: string, namespace?: string): Promise<{ ns: string; id: string }> {
    const t = spec.trim();
    if (!t) throw new NomadApiError(400, "Nomad plugin: the job specification is empty");
    let job: Record<string, unknown>;
    let submission: Record<string, unknown> | undefined;
    if (t.startsWith("{")) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(t) as Record<string, unknown>;
      } catch {
        throw new NomadApiError(400, "Nomad plugin: the job specification is not valid JSON");
      }
      job = (parsed["Job"] as Record<string, unknown> | undefined) ?? parsed;
      submission = { Source: t, Format: "json" };
    } else {
      job = await this.post<Record<string, unknown>>("/jobs/parse", {
        JobHCL: t,
        Canonicalize: true,
      });
      submission = { Source: t, Format: "hcl2" };
    }
    if (namespace) job["Namespace"] = namespace;
    const ns = String(job["Namespace"] ?? "default");
    await this.post(
      "/jobs",
      { Job: job, Submission: { ...submission, Namespace: ns, JobID: job["ID"] } },
      { namespace: ns },
    );
    return { ns, id: String(job["ID"] ?? "") };
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const text = (k: string) => (fields[k] ?? "").trim();
    const need = (k: string, what: string) => {
      const v = text(k);
      if (!v) throw new NomadApiError(400, `Nomad plugin: ${what} is required`);
      return v;
    };
    const ref = (ext: string) => `${accountId}:${typeId}:${ext}`;
    switch (typeId) {
      case "nomad-namespace": {
        const name = need("name", "a name");
        await this.post("/namespace", {
          Name: name,
          Description: text("description"),
          Meta: parseMeta(fields["meta"]),
        });
        return this.getResource(typeId, ref(encodeURIComponent(name)), accountId);
      }
      case "nomad-node-pool": {
        const name = need("name", "a name");
        await this.post("/node/pools", {
          Name: name,
          Description: text("description"),
          ...(text("schedulerAlgorithm")
            ? { SchedulerConfiguration: { SchedulerAlgorithm: text("schedulerAlgorithm") } }
            : {}),
        });
        return this.getResource(typeId, ref(encodeURIComponent(name)), accountId);
      }
      case "nomad-job": {
        const { ns, id } = await this.register(
          fields["jobspec"] ?? "",
          text("namespace") || undefined,
        );
        return this.getResource(typeId, ref(joinId(ns, id)), accountId);
      }
      case "nomad-variable": {
        const ns = text("namespace") || "default";
        const path = need("path", "a path").replace(/^\/+|\/+$/g, "");
        if (!/^[a-zA-Z0-9\-_~/]{1,128}$/.test(path))
          throw new NomadApiError(
            400,
            "Nomad plugin: variable paths use letters, digits, - _ ~ and / (up to 128)",
          );
        const items = parseItems(fields["items"] ?? "");
        if (!Object.keys(items).length)
          throw new NomadApiError(400, "Nomad plugin: add at least one item");
        await nomadFetch(this.ctx, `/var/${encodePath(path)}`, {
          method: "PUT",
          query: { namespace: ns, cas: 0 },
          body: { Namespace: ns, Path: path, Items: items },
        });
        return this.getResource(typeId, ref(joinId(ns, path)), accountId);
      }
      case "nomad-acl-policy": {
        const name = need("name", "a name");
        await this.post(`/acl/policy/${encodeURIComponent(name)}`, {
          Name: name,
          Description: text("description"),
          Rules: fields["rules"] ?? "",
        });
        return this.getResource(typeId, ref(encodeURIComponent(name)), accountId);
      }
      case "nomad-acl-token": {
        const type = text("type") || "client";
        const policies = parsePolicyList(fields["policies"]);
        if (type === "client" && !policies.length)
          throw new NomadApiError(400, "Nomad plugin: a client token needs at least one policy");
        const t = await this.post<AclToken>("/acl/token", {
          Name: text("name"),
          Type: type,
          Policies: type === "client" ? policies : [],
          Global: text("global") === "true",
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
      default:
        throw new NomadApiError(400, `Nomad plugin: cannot create "${typeId}" from Infrawrench`);
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
      case "nomad-namespace": {
        const cur = await this.get<{
          Name?: string;
          Description?: string;
          Meta?: Record<string, string>;
          Quota?: string;
        }>(`/namespace/${id}`);
        await this.post(`/namespace/${id}`, {
          ...cur,
          Name: cur.Name,
          Description: has("description") ? text("description") : cur.Description,
          Meta: has("meta") ? parseMeta(fields["meta"]) : cur.Meta,
          ...(has("quota") ? { Quota: text("quota") } : {}),
        });
        break;
      }
      case "nomad-node-pool": {
        const cur = await this.get<Record<string, unknown>>(`/node/pool/${id}`);
        await this.post("/node/pools", {
          ...cur,
          ...(has("description") ? { Description: text("description") } : {}),
          ...(has("meta") ? { Meta: parseMeta(fields["meta"]) } : {}),
          ...(has("schedulerAlgorithm")
            ? {
                SchedulerConfiguration: text("schedulerAlgorithm")
                  ? { SchedulerAlgorithm: text("schedulerAlgorithm") }
                  : null,
              }
            : {}),
        });
        break;
      }
      case "nomad-acl-policy": {
        const cur = await this.get<{ Name?: string; Description?: string; Rules?: string }>(
          `/acl/policy/${id}`,
        );
        await this.post(`/acl/policy/${id}`, {
          Name: cur.Name,
          Description: has("description") ? text("description") : cur.Description,
          Rules: has("rules") ? (fields["rules"] ?? "") : cur.Rules,
        });
        break;
      }
      case "nomad-acl-token": {
        const cur = await this.get<AclToken>(`/acl/token/${encodeURIComponent(id)}`);
        await this.post(`/acl/token/${encodeURIComponent(id)}`, {
          AccessorID: id,
          Name: has("name") ? text("name") : cur.Name,
          Type: cur.Type,
          Policies: has("policies") ? parsePolicyList(fields["policies"]) : cur.Policies,
          Roles: cur.Roles ?? [],
          Global: cur.Global,
        });
        break;
      }
      default:
        throw new NomadApiError(400, `Nomad plugin: "${typeId}" cannot be edited from Infrawrench`);
    }
    return this.getResource(typeId, resourceId, accountId);
  }

  async deleteResource(typeId: string, resourceId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const del = (path: string, query?: Query) =>
      nomadFetch(this.ctx, path, { method: "DELETE", ...(query ? { query } : {}) });
    switch (typeId) {
      case "nomad-namespace":
        if (decodeURIComponent(id) === "default")
          throw new NomadApiError(400, "Nomad plugin: the default namespace cannot be deleted");
        await del(`/namespace/${id}`);
        return;
      case "nomad-node-pool":
        if (["all", "default"].includes(decodeURIComponent(id)))
          throw new NomadApiError(400, "Nomad plugin: the all and default node pools are built in");
        await del(`/node/pool/${id}`);
        return;
      case "nomad-node":
        await this.post(`/node/${encodeURIComponent(id)}/purge`, {});
        return;
      case "nomad-job": {
        const [ns, jobId] = splitId(id, 2);
        await del(`/job/${encodeURIComponent(jobId!)}`, { namespace: ns!, purge: true });
        return;
      }
      case "nomad-variable": {
        const [ns, path] = splitId(id, 2);
        await del(`/var/${encodePath(path!)}`, { namespace: ns! });
        return;
      }
      case "nomad-acl-policy":
        await del(`/acl/policy/${id}`);
        return;
      case "nomad-acl-token":
        await del(`/acl/token/${encodeURIComponent(id)}`);
        return;
      case "nomad-volume": {
        const [type, ns, volId] = splitId(id, 3);
        if (type === "csi")
          await del(`/volume/csi/${encodeURIComponent(volId!)}`, { namespace: ns! });
        else await del(`/volume/host/${encodeURIComponent(volId!)}/delete`, { namespace: ns! });
        return;
      }
      default:
        throw new NomadApiError(
          400,
          `Nomad plugin: "${typeId}" cannot be deleted from Infrawrench`,
        );
    }
  }

  async invokeAction(typeId: string, resourceId: string, actionId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const jobPath = () => {
      const [ns, jobId] = splitId(id, 2);
      return { ns: ns!, base: `/job/${encodeURIComponent(jobId!)}`, jobId: jobId! };
    };
    switch (`${typeId}:${actionId}`) {
      case "nomad-job:stop": {
        const j = jobPath();
        await nomadFetch(this.ctx, j.base, {
          method: "DELETE",
          query: { namespace: j.ns, purge: false },
        });
        return;
      }
      case "nomad-job:start": {
        const j = jobPath();
        const job = await this.job(j.ns, j.jobId);
        await this.post("/jobs", { Job: { ...job, Stop: false } }, { namespace: j.ns });
        return;
      }
      case "nomad-job:force-periodic": {
        const j = jobPath();
        await this.post(`${j.base}/periodic/force`, {}, { namespace: j.ns });
        return;
      }
      case "nomad-job:evaluate": {
        const j = jobPath();
        await this.post(
          `${j.base}/evaluate`,
          { JobID: j.jobId, EvalOptions: { ForceReschedule: true } },
          { namespace: j.ns },
        );
        return;
      }
      case "nomad-allocation:restart":
        await this.post(`/client/allocation/${encodeURIComponent(id)}/restart`, { AllTasks: true });
        return;
      case "nomad-allocation:stop":
        await this.post(`/allocation/${encodeURIComponent(id)}/stop`, {});
        return;
      case "nomad-deployment:promote":
        await this.post(`/deployment/promote/${encodeURIComponent(id)}`, {
          DeploymentID: id,
          All: true,
        });
        return;
      case "nomad-deployment:fail":
        await this.post(`/deployment/fail/${encodeURIComponent(id)}`, { DeploymentID: id });
        return;
      case "nomad-deployment:pause":
      case "nomad-deployment:resume":
        await this.post(`/deployment/pause/${encodeURIComponent(id)}`, {
          DeploymentID: id,
          Pause: actionId === "pause",
        });
        return;
      case "nomad-node:cancel-drain":
        await this.post(`/node/${encodeURIComponent(id)}/drain`, {
          DrainSpec: null,
          MarkEligible: true,
        });
        return;
      case "nomad-node:eligible":
      case "nomad-node:ineligible":
        await this.post(`/node/${encodeURIComponent(id)}/eligibility`, { Eligibility: actionId });
        return;
      default:
        throw new NomadApiError(400, `Nomad plugin: unknown action "${actionId}" for "${typeId}"`);
    }
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const v = decodePromptArgs(args);
    const id = externalIdOf(resourceId);
    switch (`${typeId}:${command}`) {
      case `nomad-job:${COMMANDS.scale}`: {
        const [ns, jobId] = splitId(id, 2);
        const count = Number(v["count"]);
        if (!Number.isInteger(count) || count < 0)
          throw new NomadApiError(400, "Nomad plugin: the count must be a whole number");
        await this.post(
          `/job/${encodeURIComponent(jobId!)}/scale`,
          {
            Count: count,
            Target: { Group: v["group"] ?? "" },
            Message: (v["message"] ?? "").trim() || "Scaled from Infrawrench",
          },
          { namespace: ns! },
        );
        return { ok: true };
      }
      case `nomad-job:${COMMANDS.dispatch}`: {
        const [ns, jobId] = splitId(id, 2);
        const payload = v["payload"] ?? "";
        const res = await this.post<{ DispatchedJobID?: string }>(
          `/job/${encodeURIComponent(jobId!)}/dispatch`,
          {
            ...(payload ? { Payload: utf8ToBase64(payload) } : {}),
            Meta: parseMeta(v["meta"]),
          },
          { namespace: ns! },
        );
        return { dispatchedJobId: res?.DispatchedJobID };
      }
      case `nomad-job:${COMMANDS.revert}`: {
        const [ns, jobId] = splitId(id, 2);
        await this.post(
          `/job/${encodeURIComponent(jobId!)}/revert`,
          { JobID: jobId, JobVersion: Number(v["version"]) },
          { namespace: ns! },
        );
        return { ok: true };
      }
      case `nomad-node:${COMMANDS.drain}`:
        await this.post(`/node/${encodeURIComponent(id)}/drain`, {
          DrainSpec: {
            Deadline: v["deadline"] === "force" ? -1 : durationNs(v["deadline"] || "1h"),
            IgnoreSystemJobs: v["ignoreSystemJobs"] === "true",
          },
          MarkEligible: false,
          Meta: { message: (v["message"] ?? "").trim() || "Drained from Infrawrench" },
        });
        return { ok: true };
      case `nomad-acl-policy:${COMMANDS.editRules}`:
        await this.updateResource(typeId, resourceId, "", { rules: v["rules"] ?? "" });
        return { ok: true };
      case `nomad-allocation:${COMMANDS.signal}`:
        await this.post(`/client/allocation/${encodeURIComponent(id)}/signal`, {
          Signal: (v["signal"] ?? "SIGHUP").trim(),
          ...((v["task"] ?? "").trim() ? { Task: v["task"]!.trim() } : {}),
        });
        return { ok: true };
      default:
        throw new NomadApiError(400, `Nomad plugin: unknown command "${command}"`);
    }
  }

  /** Job: the submitted source (HCL as written) and the version list. Allocation: task events. */
  async describeResource(typeId: string, resourceId: string, accountId: string): Promise<string> {
    const id = externalIdOf(resourceId);
    if (typeId === "nomad-job") {
      const [ns, jobId] = splitId(id, 2);
      const job = await this.job(ns!, jobId!);
      const sub = await this.soft(
        this.get<{ Source?: string; Format?: string }>(
          `/job/${encodeURIComponent(jobId!)}/submission`,
          {
            namespace: ns!,
            version: job.Version ?? 0,
          },
        ),
      );
      return sub?.Source
        ? `# Submitted source (${sub.Format ?? "hcl2"}), version ${job.Version ?? 0}\n\n${sub.Source}`
        : `# No source was stored with version ${job.Version ?? 0}; the Manifest tab shows the registered JSON.\n`;
    }
    if (typeId === "nomad-allocation") {
      const a = await this.get<{
        TaskStates?: Record<
          string,
          {
            State?: string;
            Events?: Array<{ Type?: string; Time?: number; DisplayMessage?: string }>;
          }
        >;
      }>(`/allocation/${encodeURIComponent(id)}`);
      const lines: string[] = [];
      for (const [task, s] of Object.entries(a.TaskStates ?? {})) {
        lines.push(`Task ${task}: ${s.State ?? "?"}`);
        for (const e of (s.Events ?? []).slice(-20))
          lines.push(
            `  ${e.Time ? new Date(Math.floor(e.Time / 1e6)).toISOString() : ""}  ${e.Type ?? ""}  ${e.DisplayMessage ?? ""}`,
          );
        lines.push("");
      }
      return lines.join("\n") || "No task events.";
    }
    const r = await this.getResource(typeId, resourceId, accountId);
    return Object.entries(r.fields)
      .map(([k, val]) => `${k}: ${String(val)}`)
      .join("\n");
  }

  /** Job: the registered job as JSON. Variable: its items as JSON. */
  async getManifest(resourceId: string): Promise<string> {
    const typeId = resourceId.split(":")[1];
    const id = externalIdOf(resourceId);
    const [ns, rest] = splitId(id, 2);
    if (typeId === "nomad-variable")
      return JSON.stringify((await this.variable(ns!, rest!)).Items ?? {}, null, 2);
    return JSON.stringify(await this.job(ns!, rest!), null, 2);
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const typeId = resourceId.split(":")[1];
    const id = externalIdOf(resourceId);
    const [ns, rest] = splitId(id, 2);
    if (typeId === "nomad-variable") {
      // Check-and-set against the version just read, so a concurrent write is not silently overwritten.
      const cur = await this.variable(ns!, rest!);
      await nomadFetch(this.ctx, `/var/${encodePath(rest!)}`, {
        method: "PUT",
        query: { namespace: ns!, ...(cur.ModifyIndex ? { cas: cur.ModifyIndex } : {}) },
        body: { Namespace: ns, Path: rest, Items: parseItems(manifest) },
      });
      return;
    }
    const { id: newId } = await this.register(manifest, ns);
    if (newId !== rest)
      throw new NomadApiError(
        400,
        `Nomad plugin: registered job "${newId}", not "${rest}"; the ID cannot change here`,
      );
  }

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderNomadDetail(resource, this.ctx.address);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderNomadSidebar(resource);
  }
}

/** A policy-picker answers a JSON array; a text field a comma list. */
export function parsePolicyList(raw: string | undefined): string[] {
  const t = (raw ?? "").trim();
  if (!t) return [];
  if (t.startsWith("[")) {
    try {
      return (JSON.parse(t) as unknown[]).map(String).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return t
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
