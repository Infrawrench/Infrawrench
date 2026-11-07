import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { ApiBody, ApiListItem, ApiResponse, PluginEffect } from "@infrawrench/plugin-base";
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
import {
  decodePromptArgs,
  externalIdOf,
  pathEncode,
  requireListPage,
  rethrowIncompleteList,
  unencodedSegment,
  utf8ToBase64,
  withinListCap,
} from "@infrawrench/plugin-base";
import type { NomadApi, NomadContext } from "./api.js";
import {
  buildContext,
  encodePath,
  joinId,
  NomadApiError,
  nomadApi,
  splitId,
  statusOf,
} from "./api.js";
import type { operations } from "./api-types.gen.js";
import type { AllocStub } from "./mappers.js";
import {
  mapAllocation,
  mapCsiPlugin,
  mapDeployment,
  jobRow,
  mapJob,
  mapNode,
  mapService,
  mapToken,
  mapVariable,
  mapVolume,
  metaText,
  nodeRow,
  parseMeta,
} from "./mappers.js";
import { COMMANDS, renderNomadDetail, renderNomadSidebar } from "./render.js";

/** Nomad answers a list whole when `per_page` is left out, so this only refuses what the host cannot prune (#572). */
const MAX_LISTED = 50_000;
/** One request each per sync. `http_max_conns_per_client` is 100 by default, so few at once. */
const MAX_POLICY_READS = 1000;
const POLICY_READS_AT_ONCE = 20;
const ALL = { namespace: "*" };

type Job = ApiResponse<operations["GetJob"]>;
type Namespace = ApiListItem<operations["GetNamespaces"], null>;
type NodePool = ApiListItem<operations["GetNodePools"], null>;
type AclPolicy = ApiResponse<operations["GetACLPolicy"]>;
type JobRegistration = ApiBody<operations["RegisterJob"]>;

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
      Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
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

const PROBES: Array<{ capability: PreflightCapability; probe: (api: NomadApi) => Promise<void> }> =
  [
    {
      capability: {
        id: "jobs",
        label: "Jobs and allocations",
        description: "List, run, stop and scale jobs; read allocations, logs and deployments.",
        requiredPermissions: [
          { id: 'namespace "*" { policy = "write" }', label: "namespace write" },
        ],
        essential: true,
      },
      probe: async (api) => {
        await api.get("/jobs", { query: ALL });
      },
    },
    {
      capability: {
        id: "nodes",
        label: "Nodes",
        description: "Read nodes; drain them and change their eligibility (node write).",
        requiredPermissions: [{ id: 'node { policy = "write" }', label: "node write" }],
      },
      probe: async (api) => {
        await api.get("/nodes");
      },
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
      probe: async (api) => {
        await api.get("/vars", { query: ALL });
      },
    },
    {
      capability: {
        id: "acl",
        label: "ACL policies and tokens",
        description: "Manage ACL policies and tokens (needs a management token).",
        requiredPermissions: [{ id: "management", label: "Management token" }],
      },
      probe: async (api) => {
        await api.get("/acl/tokens");
      },
    },
    {
      capability: {
        id: "agent",
        label: "Agent and metrics",
        description: "Read the agent's configuration, cluster members and telemetry.",
        requiredPermissions: [{ id: 'agent { policy = "read" }', label: "agent read" }],
      },
      probe: async (api) => {
        await api.get("/agent/self");
      },
    },
  ];

export const NOMAD_PREFLIGHT = { capabilities: PROBES.map((p) => p.capability) };

/** Go writes an empty slice as `null`, so that alone means none: nothing else may prune a list. */
function rows<T>(path: string, body: readonly T[] | null | undefined): T[] {
  return requireListPage(body === null ? [] : body, { vendor: "Nomad", path, key: null });
}

export class NomadClient implements PluginClient {
  private readonly ctx: NomadContext;
  private readonly api: NomadApi;

  constructor(credentials: Credentials, services?: HostServices) {
    this.ctx = buildContext(credentials, services?.http);
    this.api = nomadApi(this.ctx);
  }

  private soft<T>(p: Promise<T>): Promise<T | undefined> {
    return p.catch((err: unknown) => {
      rethrowIncompleteList(err);
      return undefined;
    });
  }

  /** A list that is empty rather than failing when ACL support is off or the feature is absent. */
  private async optional<T>(path: string, p: Promise<T[] | null | undefined>): Promise<T[]> {
    try {
      return rows(path, await p);
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
      this.api.get("/status/leader"),
      this.soft(this.api.get("/status/peers")),
      this.soft(this.api.get("/agent/self")),
      this.soft(this.api.get("/agent/members")),
      this.soft(this.api.get("/regions")),
      this.soft(this.api.get("/nodes")),
      this.soft(this.api.get("/jobs", { query: ALL })),
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

  private async variables() {
    return rows("/vars", await this.api.get("/vars", { query: ALL }));
  }

  private variable(ns: string, path: string) {
    return this.api.get(`/var/${unencodedSegment(encodePath(path))}`, { query: { namespace: ns } });
  }

  /**
   * List rows have no version. This route has them all in one request, but it is
   * Nomad 1.8+, undocumented, and built for the web UI, so whatever it answers only
   * ever leaves a version blank. Without `include_children` it skips the child jobs
   * that `/jobs` lists.
   */
  private async jobVersions(): Promise<Map<string, number>> {
    const rows = await this.soft(
      this.api.get("/jobs/statuses", { query: { ...ALL, include_children: true } }),
    );
    const versions = new Map<string, number>();
    if (!Array.isArray(rows)) return versions;
    for (const r of rows)
      if (typeof r.Version === "number")
        versions.set(joinId(r.Namespace ?? "default", r.ID ?? ""), r.Version);
    return versions;
  }

  private job(ns: string, id: string) {
    return this.api.get(`/job/${pathEncode(id)}`, { query: { namespace: ns } });
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
      switch (typeId) {
        case "nomad-cluster":
          return [await this.cluster(accountId)];
        case "nomad-namespace":
          return rows("/namespaces", await this.api.get("/namespaces")).map((n) =>
            this.mapNamespace(accountId, n),
          );
        case "nomad-node-pool": {
          const [pools, nodes] = await Promise.all([
            this.api.get("/node/pools"),
            this.soft(this.api.get("/nodes")),
          ]);
          return rows("/node/pools", pools).map((p) =>
            this.mapPool(accountId, p, nodes?.filter((n) => n.NodePool === p.Name).length),
          );
        }
        case "nomad-node":
          return rows("/nodes", await this.api.get("/nodes", { query: { resources: true } })).map(
            (n) => mapNode(accountId, n),
          );
        case "nomad-job": {
          const [jobs, versions] = await Promise.all([
            this.api.get("/jobs", { query: ALL }),
            this.jobVersions(),
          ]);
          return withinListCap(rows("/jobs", jobs), MAX_LISTED, {
            vendor: "Nomad",
            path: "/jobs",
          }).map((j) => {
            const version = versions.get(joinId(j.Namespace ?? "default", j.ID ?? ""));
            return mapJob(accountId, {
              ...j,
              ...(version !== undefined ? { Version: version } : {}),
            });
          });
        }
        case "nomad-allocation": {
          const allocs = rows(
            "/allocations",
            await this.api.get("/allocations", { query: { ...ALL, resources: false } }),
          );
          const live = (a: AllocStub) =>
            a.ClientStatus === "running" || a.ClientStatus === "pending" ? 1 : 0;
          return withinListCap(allocs, MAX_LISTED, { vendor: "Nomad", path: "/allocations" })
            .sort((a, b) => live(b) - live(a) || (b.ModifyTime ?? 0) - (a.ModifyTime ?? 0))
            .map((a) => mapAllocation(accountId, a));
        }
        case "nomad-deployment":
          return withinListCap(
            rows("/deployments", await this.api.get("/deployments", { query: ALL })),
            MAX_LISTED,
            { vendor: "Nomad", path: "/deployments" },
          ).map((d) => mapDeployment(accountId, d));
        case "nomad-variable":
          return (await this.variables()).map((v) => mapVariable(accountId, v));
        case "nomad-acl-policy": {
          // The list omits the rules; read them (policies are few) so Terraform export has them.
          const list = withinListCap(
            await this.optional("/acl/policies", this.api.get("/acl/policies")),
            MAX_POLICY_READS,
            { vendor: "Nomad", path: "/acl/policies" },
          );
          const policies: ResourceInstance[] = [];
          for (let i = 0; i < list.length; i += POLICY_READS_AT_ONCE) {
            const read = list
              .slice(i, i + POLICY_READS_AT_ONCE)
              .map(async (p) =>
                this.mapPolicy(
                  accountId,
                  (await this.soft(this.api.get(`/acl/policy/${pathEncode(p.Name ?? "")}`))) ?? p,
                ),
              );
            policies.push(...(await Promise.all(read)));
          }
          return policies;
        }
        case "nomad-acl-token":
          return (await this.optional("/acl/tokens", this.api.get("/acl/tokens"))).map((t) =>
            mapToken(accountId, t),
          );
        case "nomad-volume": {
          const [csi, host] = await Promise.all([
            this.optional("/volumes", this.api.get("/volumes", { query: { ...ALL, type: "csi" } })),
            // Before Nomad 1.10 this is a 200 with no body (csi_endpoint.go: `return nil, nil`).
            this.optional(
              "/volumes",
              this.api.get("/volumes", { query: { ...ALL, type: "host" } }).then((v) => v ?? []),
            ),
          ]);
          return [
            ...csi.map((v) => mapVolume(accountId, v, "csi")),
            ...host.map((v) => mapVolume(accountId, v, "host")),
          ];
        }
        case "nomad-csi-plugin":
          return (
            await this.optional("/plugins", this.api.get("/plugins", { query: { type: "csi" } }))
          ).map((p) => mapCsiPlugin(accountId, p));
        case "nomad-service": {
          const groups = rows("/services", await this.api.get("/services", { query: ALL }));
          return groups.flatMap((g) =>
            (g.Services ?? []).map((s) =>
              mapService(accountId, g.Namespace ?? "default", s.ServiceName ?? "", s.Tags ?? []),
            ),
          );
        }
        default:
          return [];
      }
    });
  }

  private mapNamespace(accountId: string, n: Namespace): ResourceInstance {
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

  private mapPool(accountId: string, p: NodePool, nodes: number | undefined): ResourceInstance {
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

  private mapPolicy(accountId: string, p: AclPolicy): ResourceInstance {
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

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "nomad-cluster":
          return this.cluster(accountId);
        case "nomad-namespace":
          return this.mapNamespace(
            accountId,
            await this.api.get(`/namespace/${unencodedSegment(id)}`),
          );
        case "nomad-node-pool": {
          const [p, nodes] = await Promise.all([
            this.api.get(`/node/pool/${unencodedSegment(id)}`),
            this.soft(this.api.get(`/node/pool/${unencodedSegment(id)}/nodes`)),
          ]);
          return this.mapPool(accountId, p, nodes?.length);
        }
        case "nomad-node": {
          const [n, allocs] = await Promise.all([
            this.api.get(`/node/${pathEncode(id)}`),
            this.soft(this.api.get(`/node/${pathEncode(id)}/allocations`)),
          ]);
          return mapNode(
            accountId,
            nodeRow(n),
            allocs?.filter((a) => a.ClientStatus === "running").length,
          );
        }
        case "nomad-job": {
          const [ns, jobId] = splitId(id, 2);
          const [job, summary] = await Promise.all([
            this.job(ns!, jobId!),
            this.soft(
              this.api.get(`/job/${pathEncode(jobId!)}/summary`, { query: { namespace: ns! } }),
            ),
          ]);
          return mapJob(accountId, jobRow(job, summary));
        }
        case "nomad-allocation":
          return mapAllocation(accountId, await this.api.get(`/allocation/${pathEncode(id)}`));
        case "nomad-deployment":
          return mapDeployment(accountId, await this.api.get(`/deployment/${pathEncode(id)}`));
        case "nomad-variable": {
          const [ns, path] = splitId(id, 2);
          return mapVariable(accountId, await this.variable(ns!, path!));
        }
        case "nomad-acl-policy":
          return this.mapPolicy(
            accountId,
            await this.api.get(`/acl/policy/${unencodedSegment(id)}`),
          );
        case "nomad-acl-token":
          return mapToken(accountId, await this.api.get(`/acl/token/${pathEncode(id)}`));
        case "nomad-volume": {
          const [type, ns, volId] = splitId(id, 3);
          return mapVolume(
            accountId,
            await this.api.get(`/volume/${unencodedSegment(type!)}/${pathEncode(volId!)}`, {
              query: { namespace: ns! },
            }),
            type!,
          );
        }
        case "nomad-csi-plugin":
          return mapCsiPlugin(accountId, await this.api.get(`/plugin/csi/${pathEncode(id)}`));
        case "nomad-service": {
          const [ns, name] = splitId(id, 2);
          const regs = await this.api.get(`/service/${pathEncode(name!)}`, {
            query: { namespace: ns! },
          });
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
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (typeId === "nomad-acl-token" && outputKey === "secretId") {
        return (await this.api.get(`/acl/token/${pathEncode(id)}`)).SecretID ?? "";
      }
      if (typeId === "nomad-variable" && outputKey === "items") {
        const [ns, path] = splitId(id, 2);
        return JSON.stringify((await this.variable(ns!, path!)).Items ?? {});
      }
      if (typeId === "nomad-acl-policy" && outputKey === "rules") {
        return (await this.api.get(`/acl/policy/${unencodedSegment(id)}`)).Rules ?? "";
      }
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      return String(r.resolvedOutputs[outputKey] ?? r.fields[outputKey] ?? "");
    });
  }

  /** Versions and groups for job prompts, service registrations, policy rules. */
  enrichDetail(resource: ResourceInstance): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = resource.externalId ?? externalIdOf(resource.id);
      const extra: Record<string, string> = {};
      const fields = { ...resource.fields };
      try {
        if (resource.resourceTypeId === "nomad-job") {
          const [ns, jobId] = splitId(id, 2);
          const [versions, job] = await Promise.all([
            this.api.get(`/job/${pathEncode(jobId!)}/versions`, { query: { namespace: ns! } }),
            this.job(ns!, jobId!),
          ]);
          if (job.Version !== undefined) fields["version"] = job.Version;
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
          const regs = await this.api.get(`/service/${pathEncode(name!)}`, {
            query: { namespace: ns! },
          });
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
          extra["rules"] = (await this.api.get(`/acl/policy/${unencodedSegment(id)}`)).Rules ?? "";
        }
        if (resource.resourceTypeId === "nomad-acl-token") {
          const policies = await this.soft(this.api.get("/acl/policies"));
          if (policies) extra["__policies__"] = JSON.stringify(policies.map((p) => p.Name ?? ""));
        }
      } catch {
        return resource;
      }
      return { ...resource, fields, resolvedOutputs: { ...resource.resolvedOutputs, ...extra } };
    });
  }

  // -------------------------------------------------------------------------
  // Logs, metrics, stats
  // -------------------------------------------------------------------------

  /**
   * Allocation task logs via `GET /client/fs/logs/:alloc?task&type&origin=end&offset&plain=true`
   * (the server forwards to the client node). Each task offers stdout and stderr.
   */
  getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): PluginEffect<LogsFetchResult> {
    return attempt(async () => {
      if (typeId !== "nomad-allocation")
        throw new NomadApiError(400, "Nomad plugin: logs are per allocation");
      const id = externalIdOf(resourceId);
      const alloc = await this.api.get(`/allocation/${pathEncode(id)}`);
      const tasks = Object.keys(alloc.TaskStates ?? {}).sort();
      const containers = tasks.flatMap((t) => [`${t} (stdout)`, `${t} (stderr)`]);
      const active =
        params.container && containers.includes(params.container)
          ? params.container
          : (containers[0] ?? "");
      if (!active) return { text: "", containers, activeContainer: "" };
      const m = /^(.*) \((stdout|stderr)\)$/.exec(active)!;
      const tail = Math.max(1, Math.min(params.tailLines ?? 200, 5000));
      const text = await this.api
        .getText(`/client/fs/logs/${pathEncode(id)}`, {
          query: {
            task: m[1]!,
            type: m[2]!,
            origin: "end",
            offset: tail * 300,
            plain: true,
            follow: false,
          },
          headers: { Accept: "text/plain" },
        })
        .then((answer) => answer.body)
        .catch((err: unknown) => {
          if (statusOf(err) === 404) return "";
          throw err;
        });
      const lines = text.split("\n");
      if (lines.length > tail + 1) lines.splice(0, lines.length - tail - 1);
      return { text: lines.join("\n"), containers, activeContainer: active };
    });
  }

  fetchDashboardStats(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      if (!["nomad-cluster", "nomad-job", "nomad-node"].includes(typeId)) return [];
      const f = (await runPluginEffect(this.getResource(typeId, resourceId, accountId))).fields;
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
    });
  }

  /** Point-in-time readings; Nomad keeps no metric history, so the host builds the series. */
  fetchMetricSeries(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
      const now = Date.now();
      const pt = (
        label: string,
        unit: string,
        value: string | number | boolean | undefined,
      ): MetricSeries[] =>
        typeof value === "number" && Number.isFinite(value)
          ? [{ label, unit, points: [{ timestamp: now, value }] }]
          : [];
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "nomad-cluster": {
          const m = await this.api.get("/metrics");
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
          const s = await this.api.get("/client/stats", { query: { node_id: id } });
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
          const s = await this.api.get(`/client/allocation/${pathEncode(id)}/stats`);
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
          const f = (await runPluginEffect(this.getResource(typeId, resourceId, accountId))).fields;
          return [
            ...pt("Running", "count", f["running"]),
            ...pt("Queued", "count", f["queued"]),
            ...pt("Failed", "count", f["failed"]),
          ];
        }
        default:
          return [];
      }
    });
  }

  verifyCredentials(): PluginEffect<PreflightResult> {
    return attempt(async () => {
      const checks = await Promise.all(
        PROBES.map(async (p): Promise<PreflightCapabilityCheck> => {
          try {
            await p.probe(this.api);
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
      const self = await this.soft(this.api.get("/acl/token/self"));
      return {
        checks,
        ...(self?.AccessorID
          ? { identity: `${self.Name || self.AccessorID} (${self.Type ?? "client"})` }
          : {}),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  private async namespacePicker(): Promise<CreateResourceConfig["fields"]> {
    const names = (await this.soft(this.api.get("/namespaces")))?.map((n) => n.Name ?? "") ?? [
      "default",
    ];
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

  getCreateConfig(typeId: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
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
          const policies = (await this.soft(this.api.get("/acl/policies"))) ?? [];
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
    });
  }

  /** HCL (parsed by the server) or JSON (bare job or `{Job: …}`) into a registered job. */
  private async register(spec: string, namespace?: string): Promise<{ ns: string; id: string }> {
    const t = spec.trim();
    if (!t) throw new NomadApiError(400, "Nomad plugin: the job specification is empty");
    let job: Job;
    let submission: NonNullable<JobRegistration["Submission"]>;
    if (t.startsWith("{")) {
      let parsed: Job & { Job?: Job };
      try {
        parsed = JSON.parse(t);
      } catch {
        throw new NomadApiError(400, "Nomad plugin: the job specification is not valid JSON");
      }
      job = parsed.Job ?? parsed;
      submission = { Source: t, Format: "json" };
    } else {
      job = await this.api.post("/jobs/parse", { body: { JobHCL: t, Canonicalize: true } });
      submission = { Source: t, Format: "hcl2" };
    }
    if (namespace) job.Namespace = namespace;
    const ns = String(job.Namespace ?? "default");
    await this.api.post("/jobs", {
      body: {
        Job: job,
        Submission: {
          ...submission,
          Namespace: ns,
          ...(job.ID !== undefined ? { JobID: job.ID } : {}),
        },
      },
      query: { namespace: ns },
    });
    return { ns, id: String(job.ID ?? "") };
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
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
          await this.api.post("/namespace", {
            body: {
              Name: name,
              Description: text("description"),
              Meta: parseMeta(fields["meta"]),
            },
          });
          return runPluginEffect(
            this.getResource(typeId, ref(encodeURIComponent(name)), accountId),
          );
        }
        case "nomad-node-pool": {
          const name = need("name", "a name");
          await this.api.post("/node/pools", {
            body: {
              Name: name,
              Description: text("description"),
              ...(text("schedulerAlgorithm")
                ? { SchedulerConfiguration: { SchedulerAlgorithm: text("schedulerAlgorithm") } }
                : {}),
            },
          });
          return runPluginEffect(
            this.getResource(typeId, ref(encodeURIComponent(name)), accountId),
          );
        }
        case "nomad-job": {
          const { ns, id } = await this.register(
            fields["jobspec"] ?? "",
            text("namespace") || undefined,
          );
          return runPluginEffect(this.getResource(typeId, ref(joinId(ns, id)), accountId));
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
          await this.api.put(`/var/${unencodedSegment(encodePath(path))}`, {
            query: { namespace: ns, cas: 0 },
            body: { Namespace: ns, Path: path, Items: items },
          });
          return runPluginEffect(this.getResource(typeId, ref(joinId(ns, path)), accountId));
        }
        case "nomad-acl-policy": {
          const name = need("name", "a name");
          await this.api.post(`/acl/policy/${pathEncode(name)}`, {
            body: {
              Name: name,
              Description: text("description"),
              Rules: fields["rules"] ?? "",
            },
          });
          return runPluginEffect(
            this.getResource(typeId, ref(encodeURIComponent(name)), accountId),
          );
        }
        case "nomad-acl-token": {
          const type = text("type") || "client";
          const policies = parsePolicyList(fields["policies"]);
          if (type === "client" && !policies.length)
            throw new NomadApiError(400, "Nomad plugin: a client token needs at least one policy");
          const t = await this.api.post("/acl/token", {
            body: {
              Name: text("name"),
              Type: type,
              Policies: type === "client" ? policies : [],
              Global: text("global") === "true",
              ...(text("ttl") ? { ExpirationTTL: text("ttl") } : {}),
            },
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
    });
  }

  updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const has = (k: string) => k in fields;
      const text = (k: string) => (fields[k] ?? "").trim();
      switch (typeId) {
        case "nomad-namespace": {
          const cur = await this.api.get(`/namespace/${unencodedSegment(id)}`);
          await this.api.post(`/namespace/${unencodedSegment(id)}`, {
            body: {
              ...cur,
              Name: cur.Name,
              Description: has("description") ? text("description") : cur.Description,
              Meta: has("meta") ? parseMeta(fields["meta"]) : cur.Meta,
              ...(has("quota") ? { Quota: text("quota") } : {}),
            },
          });
          break;
        }
        case "nomad-node-pool": {
          const cur = await this.api.get(`/node/pool/${unencodedSegment(id)}`);
          await this.api.post("/node/pools", {
            body: {
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
            },
          });
          break;
        }
        case "nomad-acl-policy": {
          const cur = await this.api.get(`/acl/policy/${unencodedSegment(id)}`);
          await this.api.post(`/acl/policy/${unencodedSegment(id)}`, {
            body: {
              Name: cur.Name,
              Description: has("description") ? text("description") : cur.Description,
              Rules: has("rules") ? (fields["rules"] ?? "") : cur.Rules,
            },
          });
          break;
        }
        case "nomad-acl-token": {
          const cur = await this.api.get(`/acl/token/${pathEncode(id)}`);
          await this.api.post(`/acl/token/${pathEncode(id)}`, {
            body: {
              AccessorID: id,
              Name: has("name") ? text("name") : cur.Name,
              Type: cur.Type,
              Policies: has("policies") ? parsePolicyList(fields["policies"]) : cur.Policies,
              Roles: cur.Roles ?? [],
              Global: cur.Global,
            },
          });
          break;
        }
        default:
          throw new NomadApiError(
            400,
            `Nomad plugin: "${typeId}" cannot be edited from Infrawrench`,
          );
      }
      return runPluginEffect(this.getResource(typeId, resourceId, accountId));
    });
  }

  deleteResource(typeId: string, resourceId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "nomad-namespace":
          if (decodeURIComponent(id) === "default")
            throw new NomadApiError(400, "Nomad plugin: the default namespace cannot be deleted");
          await this.api.delete(`/namespace/${unencodedSegment(id)}`);
          return;
        case "nomad-node-pool":
          if (["all", "default"].includes(decodeURIComponent(id)))
            throw new NomadApiError(
              400,
              "Nomad plugin: the all and default node pools are built in",
            );
          await this.api.delete(`/node/pool/${unencodedSegment(id)}`);
          return;
        case "nomad-node":
          await this.api.post(`/node/${pathEncode(id)}/purge`, { body: {} });
          return;
        case "nomad-job": {
          const [ns, jobId] = splitId(id, 2);
          await this.api.delete(`/job/${pathEncode(jobId!)}`, {
            query: { namespace: ns!, purge: true },
          });
          return;
        }
        case "nomad-variable": {
          const [ns, path] = splitId(id, 2);
          await this.api.delete(`/var/${unencodedSegment(encodePath(path!))}`, {
            query: { namespace: ns! },
          });
          return;
        }
        case "nomad-acl-policy":
          await this.api.delete(`/acl/policy/${unencodedSegment(id)}`);
          return;
        case "nomad-acl-token":
          await this.api.delete(`/acl/token/${pathEncode(id)}`);
          return;
        case "nomad-volume": {
          const [type, ns, volId] = splitId(id, 3);
          const query = { namespace: ns! };
          if (type === "csi") await this.api.delete(`/volume/csi/${pathEncode(volId!)}`, { query });
          else await this.api.delete(`/volume/host/${pathEncode(volId!)}/delete`, { query });
          return;
        }
        default:
          throw new NomadApiError(
            400,
            `Nomad plugin: "${typeId}" cannot be deleted from Infrawrench`,
          );
      }
    });
  }

  invokeAction(typeId: string, resourceId: string, actionId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const jobPath = () => {
        const [ns, jobId] = splitId(id, 2);
        return { ns: ns!, segment: pathEncode(jobId!), jobId: jobId! };
      };
      switch (`${typeId}:${actionId}`) {
        case "nomad-job:stop": {
          const j = jobPath();
          await this.api.delete(`/job/${j.segment}`, {
            query: { namespace: j.ns, purge: false },
          });
          return;
        }
        case "nomad-job:start": {
          const j = jobPath();
          const job = await this.job(j.ns, j.jobId);
          await this.api.post("/jobs", {
            body: { Job: { ...job, Stop: false } },
            query: { namespace: j.ns },
          });
          return;
        }
        case "nomad-job:force-periodic": {
          const j = jobPath();
          await this.api.post(`/job/${j.segment}/periodic/force`, {
            body: {},
            query: { namespace: j.ns },
          });
          return;
        }
        case "nomad-job:evaluate": {
          const j = jobPath();
          await this.api.post(`/job/${j.segment}/evaluate`, {
            body: { JobID: j.jobId, EvalOptions: { ForceReschedule: true } },
            query: { namespace: j.ns },
          });
          return;
        }
        case "nomad-allocation:restart":
          await this.api.post(`/client/allocation/${pathEncode(id)}/restart`, {
            body: { AllTasks: true },
          });
          return;
        case "nomad-allocation:stop":
          await this.api.post(`/allocation/${pathEncode(id)}/stop`, { body: {} });
          return;
        case "nomad-deployment:promote":
          await this.api.post(`/deployment/promote/${pathEncode(id)}`, {
            body: { DeploymentID: id, All: true },
          });
          return;
        case "nomad-deployment:fail":
          await this.api.post(`/deployment/fail/${pathEncode(id)}`, {
            body: { DeploymentID: id },
          });
          return;
        case "nomad-deployment:pause":
        case "nomad-deployment:resume":
          await this.api.post(`/deployment/pause/${pathEncode(id)}`, {
            body: { DeploymentID: id, Pause: actionId === "pause" },
          });
          return;
        case "nomad-node:cancel-drain":
          await this.api.post(`/node/${pathEncode(id)}/drain`, {
            body: { DrainSpec: null, MarkEligible: true },
          });
          return;
        case "nomad-node:eligible":
        case "nomad-node:ineligible":
          await this.api.post(`/node/${pathEncode(id)}/eligibility`, {
            body: { Eligibility: actionId },
          });
          return;
        default:
          throw new NomadApiError(
            400,
            `Nomad plugin: unknown action "${actionId}" for "${typeId}"`,
          );
      }
    });
  }

  executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): PluginEffect<unknown> {
    return attempt(async () => {
      const v = decodePromptArgs(args);
      const id = externalIdOf(resourceId);
      switch (`${typeId}:${command}`) {
        case `nomad-job:${COMMANDS.scale}`: {
          const [ns, jobId] = splitId(id, 2);
          const count = Number(v["count"]);
          if (!Number.isInteger(count) || count < 0)
            throw new NomadApiError(400, "Nomad plugin: the count must be a whole number");
          await this.api.post(`/job/${pathEncode(jobId!)}/scale`, {
            body: {
              Count: count,
              Target: { Group: v["group"] ?? "" },
              Message: (v["message"] ?? "").trim() || "Scaled from Infrawrench",
            },
            query: { namespace: ns! },
          });
          return { ok: true };
        }
        case `nomad-job:${COMMANDS.dispatch}`: {
          const [ns, jobId] = splitId(id, 2);
          const payload = v["payload"] ?? "";
          const res = await this.api.post(`/job/${pathEncode(jobId!)}/dispatch`, {
            body: {
              ...(payload ? { Payload: utf8ToBase64(payload) } : {}),
              Meta: parseMeta(v["meta"]),
            },
            query: { namespace: ns! },
          });
          return { dispatchedJobId: res?.DispatchedJobID };
        }
        case `nomad-job:${COMMANDS.revert}`: {
          const [ns, jobId] = splitId(id, 2);
          await this.api.post(`/job/${pathEncode(jobId!)}/revert`, {
            body: { JobID: jobId, JobVersion: Number(v["version"]) },
            query: { namespace: ns! },
          });
          return { ok: true };
        }
        case `nomad-node:${COMMANDS.drain}`:
          await this.api.post(`/node/${pathEncode(id)}/drain`, {
            body: {
              DrainSpec: {
                Deadline: v["deadline"] === "force" ? -1 : durationNs(v["deadline"] || "1h"),
                IgnoreSystemJobs: v["ignoreSystemJobs"] === "true",
              },
              MarkEligible: false,
              Meta: { message: (v["message"] ?? "").trim() || "Drained from Infrawrench" },
            },
          });
          return { ok: true };
        case `nomad-acl-policy:${COMMANDS.editRules}`:
          await runPluginEffect(
            this.updateResource(typeId, resourceId, "", { rules: v["rules"] ?? "" }),
          );
          return { ok: true };
        case `nomad-allocation:${COMMANDS.signal}`:
          await this.api.post(`/client/allocation/${pathEncode(id)}/signal`, {
            body: {
              Signal: (v["signal"] ?? "SIGHUP").trim(),
              ...((v["task"] ?? "").trim() ? { Task: v["task"]!.trim() } : {}),
            },
          });
          return { ok: true };
        default:
          throw new NomadApiError(400, `Nomad plugin: unknown command "${command}"`);
      }
    });
  }

  /** Job: the submitted source (HCL as written) and the version list. Allocation: task events. */
  describeResource(typeId: string, resourceId: string, accountId: string): PluginEffect<string> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (typeId === "nomad-job") {
        const [ns, jobId] = splitId(id, 2);
        const job = await this.job(ns!, jobId!);
        const sub = await this.soft(
          this.api.get(`/job/${pathEncode(jobId!)}/submission`, {
            query: { namespace: ns!, version: job.Version ?? 0 },
          }),
        );
        return sub?.Source
          ? `# Submitted source (${sub.Format ?? "hcl2"}), version ${job.Version ?? 0}\n\n${sub.Source}`
          : `# No source was stored with version ${job.Version ?? 0}; the Manifest tab shows the registered JSON.\n`;
      }
      if (typeId === "nomad-allocation") {
        const a = await this.api.get(`/allocation/${pathEncode(id)}`);
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
      const r = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      return Object.entries(r.fields)
        .map(([k, val]) => `${k}: ${String(val)}`)
        .join("\n");
    });
  }

  /** Job: the registered job as JSON. Variable: its items as JSON. */
  getManifest(resourceId: string): PluginEffect<string> {
    return attempt(async () => {
      const typeId = resourceId.split(":")[1];
      const id = externalIdOf(resourceId);
      const [ns, rest] = splitId(id, 2);
      if (typeId === "nomad-variable")
        return JSON.stringify((await this.variable(ns!, rest!)).Items ?? {}, null, 2);
      return JSON.stringify(await this.job(ns!, rest!), null, 2);
    });
  }

  applyManifest(resourceId: string, _accountId: string, manifest: string): PluginEffect<void> {
    return attempt(async () => {
      const typeId = resourceId.split(":")[1];
      const id = externalIdOf(resourceId);
      const [ns, rest] = splitId(id, 2);
      if (typeId === "nomad-variable") {
        // Check-and-set against the version just read, so a concurrent write is not silently overwritten.
        const cur = await this.variable(ns!, rest!);
        await this.api.put(`/var/${unencodedSegment(encodePath(rest!))}`, {
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
    });
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
      const parsed: unknown = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // fall through
    }
  }
  return t
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
