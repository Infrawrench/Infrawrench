import type {
  CreateFieldConfig,
  CreateResourceConfig,
  CredentialExport,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  LogsFetchParams,
  LogsFetchResult,
  MetricSeries,
  PluginClient,
  PreflightCapabilityCheck,
  PreflightResult,
  ResourceCreateReturn,
  ResourceInstance,
  SecretHostServices,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { BkContext } from "./api.js";
import {
  BuildkiteApiError,
  bkFetch,
  bkPaged,
  bkRequest,
  cleanLog,
  enc,
  isPermissionError,
  statusOf,
} from "./api.js";
import type {
  BkAgent,
  BkAgentToken,
  BkAnnotation,
  BkArtifact,
  BkBuild,
  BkCluster,
  BkJob,
  BkOrganization,
  BkPipeline,
  BkQueue,
  BkSchedule,
  BkSecret,
  BkSuite,
  BkTeam,
  BkTemplate,
  BkTest,
} from "./mappers.js";
import {
  agentPlacement,
  linesToEnv,
  mapAgent,
  mapAgentToken,
  mapBuild,
  mapCluster,
  mapJob,
  mapOrganization,
  mapPipeline,
  mapQueue,
  mapSchedule,
  mapSecret,
  mapSuite,
  mapTemplate,
  mapTest,
  splitFirst,
} from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS, buildMetrics, rangeOrDefault } from "./metrics.js";
import { PREFLIGHT_CAPABILITIES } from "./preflight.js";
import { DETAIL_KEYS, renderBuildkiteDetail, renderBuildkiteSidebar } from "./render.js";
import { INSTANCE_SHAPES } from "./resource-types.js";

/** Builds listed (and whose jobs are listed): the most recent across the organization. */
const BUILD_LIMIT = 50;
/** Bytes of log read per requested line, for the Range tail. */
const BYTES_PER_LINE = 240;
const MAX_LOG_BYTES = 2_000_000;
/** Test Engine's metrics come back only when this version (or later) is requested. */
const TEST_ENGINE_VERSION = { "Buildkite-Version": "2026-08-01" };

const DEFAULT_STEPS = `steps:
  - label: ":pipeline: Upload"
    command: buildkite-agent pipeline upload
`;

const bool = (v: string | undefined) => v === "true" || v === "1";

/** Attach detail-only data to a resource for the renderer. */
function stash(r: ResourceInstance, data: Record<string, unknown>): ResourceInstance {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) extra[k] = JSON.stringify(v);
  return { ...r, resolvedOutputs: { ...r.resolvedOutputs, ...extra } };
}

/** JSON form values from a prompt action. */
function parseFormArg(raw: string | number | undefined): Record<string, string> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) out[k] = String(v ?? "");
    return out;
  } catch {
    return {};
  }
}

/** The last `n` lines of a text. */
export function tailLines(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n") + (lines.length > 0 ? "\n" : "");
}

/** Request body for a pipeline create or update, from form field values. */
export function pipelineBody(fields: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const has = (k: string) => k in fields;
  const text = (k: string) => (fields[k] ?? "").trim();
  if (has("name")) body["name"] = text("name");
  if (has("description")) body["description"] = text("description");
  if (has("repository")) body["repository"] = text("repository");
  if (has("defaultBranch")) body["default_branch"] = text("defaultBranch");
  if (has("branchConfiguration"))
    body["branch_configuration"] = text("branchConfiguration") || null;
  if (has("skipQueuedBranchBuilds"))
    body["skip_queued_branch_builds"] = bool(fields["skipQueuedBranchBuilds"]);
  if (has("skipQueuedBranchBuildsFilter")) {
    body["skip_queued_branch_builds_filter"] = text("skipQueuedBranchBuildsFilter") || null;
  }
  if (has("cancelRunningBranchBuilds")) {
    body["cancel_running_branch_builds"] = bool(fields["cancelRunningBranchBuilds"]);
  }
  if (has("cancelRunningBranchBuildsFilter")) {
    body["cancel_running_branch_builds_filter"] = text("cancelRunningBranchBuildsFilter") || null;
  }
  if (has("allowRebuilds")) body["allow_rebuilds"] = bool(fields["allowRebuilds"]);
  if (has("visibility") && text("visibility")) body["visibility"] = text("visibility");
  for (const [key, api] of [
    ["defaultTimeoutMinutes", "default_command_step_timeout"],
    ["maximumTimeoutMinutes", "maximum_command_step_timeout"],
  ] as const) {
    if (!has(key)) continue;
    const raw = text(key);
    if (!raw) {
      body[api] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Buildkite plugin: step timeouts are whole minutes, got "${raw}"`);
    }
    body[api] = n;
  }
  if (has("tags")) {
    body["tags"] = text("tags")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return body;
}

export class BuildkiteClient implements PluginClient {
  private readonly ctx: BkContext;
  private readonly org: string;
  private readonly secrets: SecretHostServices | undefined;
  private orgCache: Promise<BkOrganization> | undefined;
  private pipelinesCache: Promise<BkPipeline[]> | undefined;
  private clustersCache: Promise<BkCluster[]> | undefined;
  private agentsCache: Promise<BkAgent[]> | undefined;
  private buildsCache: Promise<BkBuild[]> | undefined;
  private suitesCache: Promise<BkSuite[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["apiToken"] ?? "").trim();
    if (!token) throw new Error("Buildkite plugin: missing apiToken credential");
    this.org = (credentials["organization"] ?? "").trim();
    if (!this.org) throw new Error("Buildkite plugin: pick an organization");
    this.ctx = { token, ...(services?.http ? { http: services.http } : {}) };
    this.secrets = services?.secrets;
  }

  /** Test seam: replace the sleep used when backing off a 429. */
  setSleep(sleep: (ms: number) => Promise<void>): void {
    this.ctx.sleep = sleep;
  }

  private get base(): string {
    return `/organizations/${enc(this.org)}`;
  }

  private get analytics(): string {
    return `/analytics/organizations/${enc(this.org)}`;
  }

  // -------------------------------------------------------------------------
  // Shared lookups (memoised per client; a failure clears the memo)
  // -------------------------------------------------------------------------

  private memo<T>(
    get: () => Promise<T> | undefined,
    set: (p: Promise<T> | undefined) => void,
    load: () => Promise<T>,
  ): Promise<T> {
    let p = get();
    if (!p) {
      p = load().catch((err: unknown) => {
        set(undefined);
        throw err;
      });
      set(p);
    }
    return p;
  }

  private organization(): Promise<BkOrganization> {
    return this.memo(
      () => this.orgCache,
      (p) => (this.orgCache = p),
      async () => {
        try {
          return await bkFetch<BkOrganization>(this.ctx, this.base);
        } catch (err) {
          if (statusOf(err) === 404) {
            throw new BuildkiteApiError(
              404,
              `Buildkite plugin: organization "${this.org}" was not found. It may have no active plan, or the token may not be allowed to access it; pick the organization again under Edit credentials.`,
            );
          }
          throw err;
        }
      },
    );
  }

  private pipelines(): Promise<BkPipeline[]> {
    return this.memo(
      () => this.pipelinesCache,
      (p) => (this.pipelinesCache = p),
      () => bkPaged<BkPipeline>(this.ctx, `${this.base}/pipelines`),
    );
  }

  private clusters(): Promise<BkCluster[]> {
    return this.memo(
      () => this.clustersCache,
      (p) => (this.clustersCache = p),
      () => bkPaged<BkCluster>(this.ctx, `${this.base}/clusters`),
    );
  }

  private agents(): Promise<BkAgent[]> {
    return this.memo(
      () => this.agentsCache,
      (p) => (this.agentsCache = p),
      () => bkPaged<BkAgent>(this.ctx, `${this.base}/agents`),
    );
  }

  private recentBuilds(): Promise<BkBuild[]> {
    return this.memo(
      () => this.buildsCache,
      (p) => (this.buildsCache = p),
      () =>
        bkFetch<BkBuild[]>(this.ctx, `${this.base}/builds`, {
          query: { per_page: BUILD_LIMIT },
        }).then((b) => b ?? []),
    );
  }

  private suites(): Promise<BkSuite[]> {
    return this.memo(
      () => this.suitesCache,
      (p) => (this.suitesCache = p),
      () => bkPaged<BkSuite>(this.ctx, `${this.analytics}/suites`),
    );
  }

  private async clusterNames(): Promise<Map<string, BkCluster>> {
    const list = await this.clusters().catch(() => [] as BkCluster[]);
    return new Map(list.map((c) => [c.id, c]));
  }

  /** Agents per `clusterId/queueId`, from the agents' web URLs. */
  private async agentsPerQueue(): Promise<Map<string, number> | undefined> {
    const agents = await this.agents().catch(() => undefined);
    if (!agents) return undefined;
    const counts = new Map<string, number>();
    for (const a of agents) {
      const p = agentPlacement(a);
      if (!p.clusterId || !p.queueId) continue;
      const k = `${p.clusterId}/${p.queueId}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      counts.set(p.clusterId, (counts.get(p.clusterId) ?? 0) + 1);
    }
    return counts;
  }

  /** Run `fn` for every cluster, skipping clusters the token may not read. */
  private async perCluster<T>(fn: (c: BkCluster) => Promise<T[]>): Promise<T[]> {
    const out: T[] = [];
    for (const c of await this.clusters()) {
      try {
        out.push(...(await fn(c)));
      } catch (err) {
        const s = statusOf(err);
        if (s !== 403 && s !== 404) throw err;
      }
    }
    return out;
  }

  private async flakyTests(suiteSlug: string): Promise<BkTest[]> {
    return bkPaged<BkTest>(
      this.ctx,
      `${this.analytics}/suites/${enc(suiteSlug)}/tests`,
      { labels: "flaky", sort_by: "reliability", order: "asc" },
      3,
      TEST_ENGINE_VERSION,
    );
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case "organization":
        return [await this.organizationResource(accountId)];
      case "pipeline": {
        this.pipelinesCache = undefined;
        const [pipelines, clusters] = await Promise.all([this.pipelines(), this.clusterNames()]);
        return pipelines.map((p) => {
          const c = p.cluster_id ? clusters.get(p.cluster_id) : undefined;
          return mapPipeline(accountId, p, c?.name, c?.graphql_id);
        });
      }
      case "build":
        this.buildsCache = undefined;
        return (await this.recentBuilds()).map((b) =>
          mapBuild(accountId, b.pipeline?.slug ?? "", b),
        );
      case "job": {
        const out: ResourceInstance[] = [];
        for (const b of await this.recentBuilds()) {
          const slug = b.pipeline?.slug ?? "";
          for (const j of b.jobs ?? []) {
            if (j.type === "waiter") continue;
            out.push(mapJob(accountId, slug, b.number, j));
          }
        }
        return out;
      }
      case "agent":
        this.agentsCache = undefined;
        return (await this.agents()).map((a) => mapAgent(accountId, a));
      case "cluster": {
        this.clustersCache = undefined;
        const [clusters, counts] = await Promise.all([this.clusters(), this.agentsPerQueue()]);
        const out: ResourceInstance[] = [];
        for (const c of clusters) {
          const queues = await bkPaged<BkQueue>(
            this.ctx,
            `${this.base}/clusters/${enc(c.id)}/queues`,
          ).catch(() => undefined);
          out.push(
            mapCluster(accountId, c, {
              ...(queues ? { queueCount: queues.length } : {}),
              ...(counts ? { agentCount: counts.get(c.id) ?? 0 } : {}),
              ...(queues && c.default_queue_id
                ? { defaultQueueKey: queues.find((q) => q.id === c.default_queue_id)?.key ?? "" }
                : {}),
            }),
          );
        }
        return out;
      }
      case "queue": {
        const counts = await this.agentsPerQueue();
        return this.perCluster(async (c) =>
          (await bkPaged<BkQueue>(this.ctx, `${this.base}/clusters/${enc(c.id)}/queues`)).map((q) =>
            mapQueue(accountId, c.id, q, {
              clusterName: c.name,
              ...(c.graphql_id ? { clusterGraphqlId: c.graphql_id } : {}),
              ...(counts ? { agentCount: counts.get(`${c.id}/${q.id}`) ?? 0 } : {}),
            }),
          ),
        );
      }
      case "agent-token":
        return this.perCluster(async (c) =>
          (await bkPaged<BkAgentToken>(this.ctx, `${this.base}/clusters/${enc(c.id)}/tokens`)).map(
            (t) => mapAgentToken(accountId, c.id, t, c.name),
          ),
        );
      case "cluster-secret":
        return this.perCluster(async (c) =>
          (await bkPaged<BkSecret>(this.ctx, `${this.base}/clusters/${enc(c.id)}/secrets`)).map(
            (s) => mapSecret(accountId, c.id, s, c.name),
          ),
        );
      case "schedule": {
        const out: ResourceInstance[] = [];
        for (const p of await this.pipelines()) {
          if (p.archived_at) continue;
          try {
            const list = await bkPaged<BkSchedule>(
              this.ctx,
              `${this.base}/pipelines/${enc(p.slug)}/schedules`,
            );
            out.push(...list.map((s) => mapSchedule(accountId, p.slug, s, p.graphql_id)));
          } catch (err) {
            const s = statusOf(err);
            if (s !== 403 && s !== 404) throw err;
          }
        }
        return out;
      }
      case "pipeline-template":
        try {
          return (await bkPaged<BkTemplate>(this.ctx, `${this.base}/pipeline-templates`)).map((t) =>
            mapTemplate(accountId, t),
          );
        } catch (err) {
          // Not an Enterprise organization, or the token lacks the scope.
          if (statusOf(err) === 403 || statusOf(err) === 404) return [];
          throw err;
        }
      case "test-suite": {
        this.suitesCache = undefined;
        let suites: BkSuite[];
        try {
          suites = await this.suites();
        } catch (err) {
          if (statusOf(err) === 403 || statusOf(err) === 404) return [];
          throw err;
        }
        const out: ResourceInstance[] = [];
        for (const s of suites) {
          const flaky = await this.flakyTests(s.slug).catch(() => undefined);
          out.push(mapSuite(accountId, s, flaky ? { flakyCount: flaky.length } : {}));
        }
        return out;
      }
      case "test": {
        let suites: BkSuite[];
        try {
          suites = await this.suites();
        } catch (err) {
          if (statusOf(err) === 403 || statusOf(err) === 404) return [];
          throw err;
        }
        const out: ResourceInstance[] = [];
        for (const s of suites) {
          const tests = await this.flakyTests(s.slug).catch(() => [] as BkTest[]);
          out.push(...tests.map((t) => mapTest(accountId, s.slug, t)));
        }
        return out;
      }
      default:
        throw new Error(`Buildkite plugin: unknown resource type "${typeId}"`);
    }
  }

  private async organizationResource(accountId: string): Promise<ResourceInstance> {
    const [org, usage, pipelines, agents, clusters, rate] = await Promise.all([
      this.organization(),
      bkFetch<{ active_users_count?: number }>(this.ctx, `${this.base}/usage`).catch(
        () => undefined,
      ),
      this.pipelines().catch(() => undefined),
      this.agents().catch(() => undefined),
      this.clusters().catch(() => undefined),
      bkFetch<{ scopes?: { rest?: { limit?: number; current?: number } } }>(
        this.ctx,
        `${this.base}/rate_limit`,
      ).catch(() => undefined),
    ]);
    const live = (pipelines ?? []).filter((p) => !p.archived_at);
    const sum = (k: keyof BkPipeline) =>
      pipelines ? live.reduce((s, p) => s + (Number(p[k]) || 0), 0) : undefined;
    const r = mapOrganization(accountId, org, {
      ...(usage?.active_users_count !== undefined ? { activeUsers: usage.active_users_count } : {}),
      ...(pipelines ? { pipelineCount: live.length } : {}),
      ...(agents
        ? { agentCount: agents.length, busyAgents: agents.filter((a) => a.job).length }
        : {}),
      ...(clusters ? { clusterCount: clusters.length } : {}),
      ...(pipelines
        ? {
            runningBuilds: sum("running_builds_count"),
            scheduledBuilds: sum("scheduled_builds_count"),
            waitingJobs: sum("waiting_jobs_count"),
          }
        : {}),
      ...(rate?.scopes?.rest?.limit !== undefined
        ? { rateLimit: rate.scopes.rest.limit, rateLimitUsed: rate.scopes.rest.current ?? 0 }
        : {}),
    });
    const busy = live
      .filter(
        (p) =>
          (p.running_builds_count ?? 0) +
            (p.scheduled_builds_count ?? 0) +
            (p.waiting_jobs_count ?? 0) >
          0,
      )
      .sort(
        (a, b) =>
          (b.waiting_jobs_count ?? 0) - (a.waiting_jobs_count ?? 0) ||
          (b.running_builds_count ?? 0) - (a.running_builds_count ?? 0),
      )
      .slice(0, 15)
      .map((p) => ({
        slug: p.slug,
        name: p.name,
        running: p.running_builds_count ?? 0,
        scheduled: p.scheduled_builds_count ?? 0,
        waiting: p.waiting_jobs_count ?? 0,
      }));
    return stash(r, { [DETAIL_KEYS.busyPipelines]: busy });
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "organization":
        return this.organizationResource(accountId);
      case "pipeline": {
        const [p, clusters] = await Promise.all([
          bkFetch<BkPipeline>(this.ctx, `${this.base}/pipelines/${enc(id)}`),
          this.clusters().catch(() => [] as BkCluster[]),
        ]);
        const builds = await bkFetch<BkBuild[]>(
          this.ctx,
          `${this.base}/pipelines/${enc(id)}/builds`,
          {
            query: { per_page: 15, exclude_jobs: true, exclude_pipeline: true },
          },
        ).catch(() => undefined);
        const c = clusters.find((x) => x.id === p.cluster_id);
        return stash(mapPipeline(accountId, p, c?.name, c?.graphql_id), {
          [DETAIL_KEYS.builds]: builds?.map((b) => ({
            ...b,
            pipeline: { slug: p.slug, name: p.name },
          })),
          [DETAIL_KEYS.clusters]: clusters.map((x) => ({ id: x.id, name: x.name })),
        });
      }
      case "build": {
        const [slug, number] = splitFirst(id);
        const path = `${this.base}/pipelines/${enc(slug)}/builds/${enc(number)}`;
        const b = await bkFetch<BkBuild>(this.ctx, path);
        const [annotations, artifacts] = await Promise.all([
          bkFetch<BkAnnotation[]>(this.ctx, `${path}/annotations`).catch(() => undefined),
          bkPaged<BkArtifact>(this.ctx, `${path}/artifacts`, {}, 2).catch(() => undefined),
        ]);
        return stash(mapBuild(accountId, slug, b), {
          [DETAIL_KEYS.jobs]: b.jobs ?? [],
          [DETAIL_KEYS.annotations]: annotations,
          [DETAIL_KEYS.artifacts]: artifacts,
        });
      }
      case "job": {
        const [slug, rest] = splitFirst(id);
        const [number, jobId] = splitFirst(rest);
        const j = await bkFetch<BkJob>(this.ctx, `${this.base}/jobs/${enc(jobId)}`);
        return mapJob(accountId, slug, Number(number), j);
      }
      case "agent":
        return mapAgent(
          accountId,
          await bkFetch<BkAgent>(this.ctx, `${this.base}/agents/${enc(id)}`),
        );
      case "cluster": {
        const [c, queues, counts] = await Promise.all([
          bkFetch<BkCluster>(this.ctx, `${this.base}/clusters/${enc(id)}`),
          bkPaged<BkQueue>(this.ctx, `${this.base}/clusters/${enc(id)}/queues`).catch(
            () => undefined,
          ),
          this.agentsPerQueue(),
        ]);
        return stash(
          mapCluster(accountId, c, {
            ...(queues ? { queueCount: queues.length } : {}),
            ...(counts ? { agentCount: counts.get(c.id) ?? 0 } : {}),
            ...(queues && c.default_queue_id
              ? { defaultQueueKey: queues.find((q) => q.id === c.default_queue_id)?.key ?? "" }
              : {}),
          }),
          { [DETAIL_KEYS.queues]: queues?.map((q) => ({ id: q.id, key: q.key })) },
        );
      }
      case "queue": {
        const [clusterId, queueId] = splitFirst(id);
        const [q, clusters, counts] = await Promise.all([
          bkFetch<BkQueue>(
            this.ctx,
            `${this.base}/clusters/${enc(clusterId)}/queues/${enc(queueId)}`,
          ),
          this.clusterNames(),
          this.agentsPerQueue(),
        ]);
        const c = clusters.get(clusterId);
        return mapQueue(accountId, clusterId, q, {
          ...(c ? { clusterName: c.name } : {}),
          ...(c?.graphql_id ? { clusterGraphqlId: c.graphql_id } : {}),
          ...(counts ? { agentCount: counts.get(id) ?? 0 } : {}),
        });
      }
      case "agent-token": {
        const [clusterId, tokenId] = splitFirst(id);
        const [t, clusters] = await Promise.all([
          bkFetch<BkAgentToken>(
            this.ctx,
            `${this.base}/clusters/${enc(clusterId)}/tokens/${enc(tokenId)}`,
          ),
          this.clusterNames(),
        ]);
        return mapAgentToken(accountId, clusterId, t, clusters.get(clusterId)?.name);
      }
      case "cluster-secret": {
        const [clusterId, secretId] = splitFirst(id);
        const [s, clusters] = await Promise.all([
          bkFetch<BkSecret>(
            this.ctx,
            `${this.base}/clusters/${enc(clusterId)}/secrets/${enc(secretId)}`,
          ),
          this.clusterNames(),
        ]);
        return mapSecret(accountId, clusterId, s, clusters.get(clusterId)?.name);
      }
      case "schedule": {
        const [slug, scheduleId] = splitFirst(id);
        const s = await bkFetch<BkSchedule>(
          this.ctx,
          `${this.base}/pipelines/${enc(slug)}/schedules/${enc(scheduleId)}`,
        );
        const pipeline = (await this.pipelines().catch(() => [] as BkPipeline[])).find(
          (p) => p.slug === slug,
        );
        return mapSchedule(accountId, slug, s, pipeline?.graphql_id);
      }
      case "pipeline-template":
        return mapTemplate(
          accountId,
          await bkFetch<BkTemplate>(this.ctx, `${this.base}/pipeline-templates/${enc(id)}`),
        );
      case "test-suite": {
        const s = await bkFetch<BkSuite>(this.ctx, `${this.analytics}/suites/${enc(id)}`);
        const flaky = await this.flakyTests(id).catch(() => undefined);
        return mapSuite(accountId, s, flaky ? { flakyCount: flaky.length } : {});
      }
      case "test": {
        const [suite, testId] = splitFirst(id);
        const t = await bkFetch<BkTest>(
          this.ctx,
          `${this.analytics}/suites/${enc(suite)}/tests/${enc(testId)}`,
          { headers: TEST_ENGINE_VERSION },
        );
        return mapTest(accountId, suite, t);
      }
      default:
        throw new Error(`Buildkite plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    if (typeId === "agent-token" && outputKey === "token") {
      const value = await this.secrets?.getPlaintext(resourceId, "token");
      if (value) return value;
      throw new Error(
        "Buildkite only returns an agent token's value when it is created. This token was not created from Infrawrench; mint a new one with Get credentials on its cluster.",
      );
    }
    if (typeId === "test-suite" && outputKey === "apiToken") {
      const s = await bkFetch<BkSuite>(
        this.ctx,
        `${this.analytics}/suites/${enc(externalIdOf(resourceId))}`,
        { query: { show_api_token: true } },
      );
      if (!s.api_token) throw new Error("Buildkite did not return the suite's API token");
      return s.api_token;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`Buildkite plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, logs, steps
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const n = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "—");
    const waitVariant = (v: unknown): NonNullable<DashboardStat["variant"]> =>
      typeof v === "number" && v > 0 ? "status-degraded" : "default";
    switch (resourceTypeId) {
      case "organization":
        return [
          { label: "Running", value: n(f["runningBuilds"]) },
          {
            label: "Waiting jobs",
            value: n(f["waitingJobs"]),
            variant: waitVariant(f["waitingJobs"]),
          },
          { label: "Agents", value: n(f["agentCount"]) },
        ];
      case "pipeline":
        return [
          { label: "Running", value: n(f["runningBuilds"]) },
          {
            label: "Waiting jobs",
            value: n(f["waitingJobs"]),
            variant: waitVariant(f["waitingJobs"]),
          },
        ];
      case "queue":
        return [
          { label: "Agents", value: n(f["agentCount"]) },
          {
            label: "Dispatch",
            value: f["dispatchPaused"] === true ? "Paused" : "On",
            variant: f["dispatchPaused"] === true ? "status-degraded" : "status-healthy",
          },
        ];
      case "cluster":
        return [
          { label: "Queues", value: n(f["queueCount"]) },
          { label: "Agents", value: n(f["agentCount"]) },
        ];
      default:
        return [];
    }
  }

  async fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): Promise<MetricSeries[]> {
    const range = rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS);
    switch (resourceTypeId) {
      case "organization":
        return buildMetrics(this.ctx, `${this.base}/builds`, range);
      case "pipeline":
        return buildMetrics(
          this.ctx,
          `${this.base}/pipelines/${enc(externalIdOf(resourceId))}/builds`,
          range,
        );
      default:
        return [];
    }
  }

  async getLogs(
    typeId: string,
    resourceId: string,
    _accountId: string,
    params: LogsFetchParams,
  ): Promise<LogsFetchResult> {
    if (typeId !== "job") throw new Error(`Buildkite plugin: no logs for "${typeId}"`);
    const [, rest] = splitFirst(externalIdOf(resourceId));
    const [, jobId] = splitFirst(rest);
    const lines = Math.max(1, params.tailLines ?? 500);
    const bytes = Math.min(MAX_LOG_BYTES, lines * BYTES_PER_LINE);
    let text = "";
    try {
      const res = await bkRequest(this.ctx, `${this.base}/jobs/${enc(jobId)}/log`, {
        headers: { Accept: "text/plain", Range: `bytes=-${bytes}` },
      });
      text = res.text;
      // A suffix range starts mid-line; drop the partial first line.
      if (res.status === 206) {
        const nl = text.indexOf("\n");
        if (nl >= 0) text = text.slice(nl + 1);
      }
    } catch (err) {
      // 416: the log is empty (the job has not printed anything yet).
      if (statusOf(err) !== 416) throw err;
    }
    return { text: tailLines(cleanLog(text), lines), containers: [], activeContainer: "" };
  }

  async getManifest(resourceId: string, _accountId: string): Promise<string> {
    const typeId = resourceId.split(":")[1];
    const id = externalIdOf(resourceId);
    if (typeId === "pipeline") {
      const p = await bkFetch<BkPipeline>(this.ctx, `${this.base}/pipelines/${enc(id)}`);
      if (typeof p.configuration === "string") return p.configuration;
      return `# This pipeline uses visual steps, which this editor cannot change.\n${JSON.stringify(p.steps ?? [], null, 2)}\n`;
    }
    if (typeId === "pipeline-template") {
      const t = await bkFetch<BkTemplate>(this.ctx, `${this.base}/pipeline-templates/${enc(id)}`);
      return t.configuration ?? "";
    }
    throw new Error(`Buildkite plugin: no editable steps for "${typeId}"`);
  }

  async applyManifest(resourceId: string, _accountId: string, manifest: string): Promise<void> {
    const typeId = resourceId.split(":")[1];
    const id = externalIdOf(resourceId);
    if (!manifest.trim())
      throw new Error("Buildkite plugin: the step configuration cannot be empty");
    if (typeId === "pipeline") {
      await bkFetch(this.ctx, `${this.base}/pipelines/${enc(id)}`, {
        method: "PATCH",
        body: { configuration: manifest },
      });
      this.pipelinesCache = undefined;
      return;
    }
    if (typeId === "pipeline-template") {
      await bkFetch(this.ctx, `${this.base}/pipeline-templates/${enc(id)}`, {
        method: "PATCH",
        body: { configuration: manifest },
      });
      return;
    }
    throw new Error(`Buildkite plugin: no editable steps for "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  private async pipelineField(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const pipelines = (await this.pipelines().catch(() => [] as BkPipeline[])).filter(
      (p) => !p.archived_at,
    );
    return [
      {
        key: "pipeline",
        label: "Pipeline",
        kind: "select",
        required: true,
        ...(pipelines[0] ? { defaultValue: pipelines[0].slug } : {}),
        options: pipelines.map((p) => ({ id: p.slug, label: p.name, description: p.slug })),
      },
    ];
  }

  private async clusterField(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const clusters = await this.clusters().catch(() => [] as BkCluster[]);
    return [
      {
        key: "cluster",
        label: "Cluster",
        kind: "select",
        required: true,
        ...(clusters[0] ? { defaultValue: clusters[0].id } : {}),
        options: clusters.map((c) => ({
          id: c.id,
          label: c.name,
          ...(c.description ? { description: c.description } : {}),
        })),
      },
    ];
  }

  private async teamOptions(): Promise<BkTeam[]> {
    return bkPaged<BkTeam>(this.ctx, `${this.base}/teams`).catch(() => [] as BkTeam[]);
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    switch (typeId) {
      case "pipeline": {
        const [teams, templates] = await Promise.all([
          this.teamOptions(),
          bkPaged<BkTemplate>(this.ctx, `${this.base}/pipeline-templates`).catch(
            () => [] as BkTemplate[],
          ),
        ]);
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "Web app" },
            {
              key: "repository",
              label: "Repository",
              kind: "text",
              required: true,
              placeholder: "git@github.com:acme/web.git",
            },
            ...(await this.clusterField()),
            {
              key: "defaultBranch",
              label: "Default branch",
              kind: "text",
              required: false,
              defaultValue: "main",
            },
            { key: "description", label: "Description", kind: "text", required: false },
            ...(templates.length > 0
              ? [
                  {
                    key: "template",
                    label: "Pipeline template",
                    kind: "select" as const,
                    required: false,
                    defaultValue: "",
                    description: "Use a shared template's steps instead of your own.",
                    options: [
                      { id: "", label: "None: write steps below" },
                      ...templates.map((t) => ({ id: t.uuid, label: t.name })),
                    ],
                  },
                ]
              : []),
            {
              key: "configuration",
              label: "Steps (YAML)",
              kind: "code",
              codeLanguage: "yaml",
              required: false,
              defaultValue: DEFAULT_STEPS,
              description:
                "The default uploads .buildkite/pipeline.yml from the repository at build time.",
              ...(templates.length > 0
                ? { showWhen: { fieldKey: "template", fieldValue: "" } }
                : {}),
            },
            ...(teams.length > 0
              ? [
                  {
                    key: "team",
                    label: "Team",
                    kind: "select" as const,
                    required: false,
                    defaultValue: teams[0]!.id,
                    description:
                      "Once Teams are on, only administrators can create a pipeline with no team.",
                    options: [
                      { id: "", label: "No team" },
                      ...teams.map((t) => ({ id: t.id, label: t.name })),
                    ],
                  },
                  {
                    key: "teamAccess",
                    label: "Team access",
                    kind: "select" as const,
                    required: false,
                    defaultValue: "manage_build_and_read",
                    options: [
                      { id: "manage_build_and_read", label: "Full access" },
                      { id: "build_and_read", label: "Build and read" },
                      { id: "read_only", label: "Read only" },
                    ],
                  },
                ]
              : []),
            {
              key: "visibility",
              label: "Visibility",
              kind: "select",
              required: false,
              defaultValue: "private",
              options: [
                { id: "private", label: "Private" },
                {
                  id: "public",
                  label: "Public",
                  description: "Builds and logs visible to anyone with the link.",
                },
              ],
            },
          ],
        };
      }
      case "build":
        return {
          fields: [
            ...(await this.pipelineField(parentResourceId)),
            {
              key: "branch",
              label: "Branch",
              kind: "text",
              required: false,
              placeholder: "main",
              description: "Leave empty for the pipeline's default branch.",
            },
            {
              key: "commit",
              label: "Commit",
              kind: "text",
              required: false,
              defaultValue: "HEAD",
              description: "A ref, SHA or tag.",
            },
            {
              key: "message",
              label: "Message",
              kind: "text",
              required: false,
              placeholder: "Deploy hotfix",
            },
            {
              key: "env",
              label: "Environment variables",
              kind: "text",
              multiline: true,
              required: false,
              placeholder: "DEPLOY_ENV=staging",
              description: "One KEY=value per line.",
            },
            {
              key: "cleanCheckout",
              label: "Clean checkout",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                {
                  id: "true",
                  label: "Yes",
                  description: "Agents delete the build directory first.",
                },
              ],
            },
            {
              key: "ignoreBranchFilters",
              label: "Ignore the pipeline's branch filter",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No" },
                { id: "true", label: "Yes" },
              ],
            },
          ],
        };
      case "cluster":
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "Production" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "emoji",
              label: "Emoji",
              kind: "text",
              required: false,
              placeholder: ":rocket:",
            },
            { key: "color", label: "Color", kind: "text", required: false, placeholder: "#14CC80" },
          ],
        };
      case "queue":
        return {
          fields: [
            ...(await this.clusterField(parentResourceId)),
            { key: "key", label: "Key", kind: "text", required: true, placeholder: "linux-large" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "kind",
              label: "Agents",
              kind: "select",
              required: true,
              defaultValue: "self-hosted",
              options: [
                {
                  id: "self-hosted",
                  label: "Self-hosted",
                  description: "Your own agents connect to it.",
                },
                {
                  id: "hosted",
                  label: "Buildkite hosted",
                  description: "Buildkite runs the agents, billed by the minute.",
                },
              ],
            },
            {
              key: "instanceShape",
              label: "Instance shape",
              kind: "size-picker",
              required: true,
              defaultValue: "LINUX_AMD64_2X4",
              showWhen: { fieldKey: "kind", fieldValue: "hosted" },
              sizes: INSTANCE_SHAPES.map((id) => {
                const m = /(\d+)X(\d+)$/.exec(id);
                const family = id.split("_").slice(0, 2).join(" ");
                return {
                  id,
                  label: id,
                  vcpus: m ? Number(m[1]) : 0,
                  memoryMb: m ? Number(m[2]) * 1024 : 0,
                  category: family,
                };
              }),
            },
            {
              key: "retryAgentAffinity",
              label: "Retried jobs go to",
              kind: "select",
              required: false,
              defaultValue: "prefer-warmest",
              options: [
                { id: "prefer-warmest", label: "The agent that most recently finished a job" },
                { id: "prefer-different", label: "A different agent, if one is free" },
              ],
            },
          ],
        };
      case "agent-token":
        return {
          fields: [
            ...(await this.clusterField(parentResourceId)),
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: true,
              placeholder: "Linux agents in the build VPC",
            },
            {
              key: "expiresAt",
              label: "Expires",
              kind: "datetime",
              required: false,
              description: "Leave empty for a token that never expires.",
            },
            {
              key: "allowedIpAddresses",
              label: "Allowed IP ranges",
              kind: "text",
              required: false,
              placeholder: "10.0.0.0/8 192.168.1.0/24",
              description: "Space-separated IPv4 CIDRs. Leave empty to allow any address.",
            },
          ],
        };
      case "cluster-secret":
        return {
          fields: [
            ...(await this.clusterField(parentResourceId)),
            {
              key: "key",
              label: "Key",
              kind: "text",
              required: true,
              placeholder: "DEPLOY_TOKEN",
              description:
                "Letters, numbers and underscores, starting with a letter; not bk or buildkite.",
            },
            { key: "value", label: "Value", kind: "password", required: true },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "policy",
              label: "Access policy (YAML)",
              kind: "code",
              codeLanguage: "yaml",
              required: false,
              placeholder: "- pipeline_slug: deploy\n  build_branch: main",
              description:
                "Which pipelines and branches may read it. Empty lets every build in the cluster read it.",
            },
          ],
        };
      case "schedule":
        return {
          fields: [
            ...(await this.pipelineField(parentResourceId)),
            {
              key: "label",
              label: "Label",
              kind: "text",
              required: true,
              placeholder: "Nightly build",
            },
            {
              key: "cronline",
              label: "Schedule",
              kind: "text",
              required: true,
              defaultValue: "@daily",
              description:
                "Cron syntax in UTC (0 2 * * 1-5), a cron with a time zone (0 2 * * * Europe/Berlin), or @hourly, @daily, @weekly, @monthly.",
            },
            { key: "branch", label: "Branch", kind: "text", required: false, placeholder: "main" },
            { key: "commit", label: "Commit", kind: "text", required: false, defaultValue: "HEAD" },
            { key: "message", label: "Build message", kind: "text", required: false },
            {
              key: "env",
              label: "Environment variables",
              kind: "text",
              multiline: true,
              required: false,
              placeholder: "NIGHTLY=true",
            },
          ],
        };
      case "pipeline-template":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "Standard build",
            },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "configuration",
              label: "Steps (YAML)",
              kind: "code",
              codeLanguage: "yaml",
              required: true,
              defaultValue: DEFAULT_STEPS,
            },
            {
              key: "available",
              label: "Available to non-admins",
              kind: "select",
              required: false,
              defaultValue: "false",
              options: [
                { id: "false", label: "No, administrators assign it" },
                { id: "true", label: "Yes, anyone can pick it for a pipeline" },
              ],
            },
          ],
        };
      case "test-suite": {
        const teams = await this.teamOptions();
        return {
          fields: [
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "RSpec" },
            {
              key: "defaultBranch",
              label: "Default branch",
              kind: "text",
              required: true,
              defaultValue: "main",
            },
            { key: "applicationName", label: "Application", kind: "text", required: false },
            ...(teams.length > 0
              ? [
                  {
                    key: "team",
                    label: "Team",
                    kind: "select" as const,
                    required: true,
                    defaultValue: teams[0]!.id,
                    description: "Organizations with Teams on must give a new suite a team.",
                    options: teams.map((t) => ({ id: t.id, label: t.name })),
                  },
                ]
              : []),
          ],
        };
      }
      default:
        throw new Error(`Buildkite plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceCreateReturn> {
    const parent = parentResourceId ? externalIdOf(parentResourceId) : undefined;
    const need = (key: string, label: string) => {
      const v = (fields[key] ?? "").trim();
      if (!v) throw new Error(`Buildkite plugin: "${label}" is required`);
      return v;
    };
    const opt = (key: string) => (fields[key] ?? "").trim();
    const cluster = () => opt("cluster") || parent || need("cluster", "Cluster");
    switch (typeId) {
      case "pipeline": {
        const template = opt("template");
        const team = opt("team");
        const body: Record<string, unknown> = {
          ...pipelineBody({
            name: need("name", "Name"),
            repository: need("repository", "Repository"),
            ...(opt("defaultBranch") ? { defaultBranch: opt("defaultBranch") } : {}),
            ...(opt("description") ? { description: opt("description") } : {}),
            ...(opt("visibility") ? { visibility: opt("visibility") } : {}),
          }),
          cluster_id: need("cluster", "Cluster"),
          ...(template
            ? { pipeline_template_uuid: template }
            : { configuration: opt("configuration") || DEFAULT_STEPS }),
          ...(team ? { teams: { [team]: opt("teamAccess") || "manage_build_and_read" } } : {}),
        };
        const p = await bkFetch<BkPipeline>(this.ctx, `${this.base}/pipelines`, {
          method: "POST",
          body,
        });
        this.pipelinesCache = undefined;
        return mapPipeline(accountId, p);
      }
      case "build": {
        const pipeline = opt("pipeline") || parent || need("pipeline", "Pipeline");
        const env = linesToEnv(fields["env"]);
        const b = await bkFetch<BkBuild>(
          this.ctx,
          `${this.base}/pipelines/${enc(pipeline)}/builds`,
          {
            method: "POST",
            body: {
              commit: opt("commit") || "HEAD",
              ...(opt("branch") ? { branch: opt("branch") } : {}),
              ...(opt("message") ? { message: opt("message") } : {}),
              ...(Object.keys(env).length > 0 ? { env } : {}),
              ...(bool(fields["cleanCheckout"]) ? { clean_checkout: true } : {}),
              ...(bool(fields["ignoreBranchFilters"])
                ? { ignore_pipeline_branch_filters: true }
                : {}),
            },
          },
        );
        return mapBuild(accountId, pipeline, b);
      }
      case "cluster": {
        const c = await bkFetch<BkCluster>(this.ctx, `${this.base}/clusters`, {
          method: "POST",
          body: {
            name: need("name", "Name"),
            ...(opt("description") ? { description: opt("description") } : {}),
            ...(opt("emoji") ? { emoji: opt("emoji") } : {}),
            ...(opt("color") ? { color: opt("color") } : {}),
          },
        });
        this.clustersCache = undefined;
        return mapCluster(accountId, c, { queueCount: 0 });
      }
      case "queue": {
        const clusterId = cluster();
        const hosted = opt("kind") === "hosted";
        const q = await bkFetch<BkQueue>(
          this.ctx,
          `${this.base}/clusters/${enc(clusterId)}/queues`,
          {
            method: "POST",
            body: {
              key: need("key", "Key"),
              ...(opt("description") ? { description: opt("description") } : {}),
              ...(opt("retryAgentAffinity")
                ? { retry_agent_affinity: opt("retryAgentAffinity") }
                : {}),
              ...(hosted
                ? { hostedAgents: { instanceShape: need("instanceShape", "Instance shape") } }
                : {}),
            },
          },
        );
        return mapQueue(accountId, clusterId, q, { agentCount: 0 });
      }
      case "agent-token": {
        const clusterId = cluster();
        const expires = opt("expiresAt");
        const t = await bkFetch<BkAgentToken>(
          this.ctx,
          `${this.base}/clusters/${enc(clusterId)}/tokens`,
          {
            method: "POST",
            body: {
              description: need("description", "Description"),
              ...(expires ? { expires_at: new Date(expires).toISOString() } : {}),
              ...(opt("allowedIpAddresses")
                ? { allowed_ip_addresses: opt("allowedIpAddresses") }
                : {}),
            },
          },
        );
        const resource = mapAgentToken(accountId, clusterId, t);
        const warnings = [];
        if (t.token && this.secrets?.setPlaintext) {
          await this.secrets.setPlaintext(resource.id, "token", t.token);
        } else {
          warnings.push({
            code: "token-not-kept",
            message:
              "The token was created, but its value could not be kept: Buildkite only shows it once. Revoke it and use Get credentials on the cluster to see a new token's value.",
          });
        }
        return { resource, warnings };
      }
      case "cluster-secret": {
        const clusterId = cluster();
        const s = await bkFetch<BkSecret>(
          this.ctx,
          `${this.base}/clusters/${enc(clusterId)}/secrets`,
          {
            method: "POST",
            body: {
              key: need("key", "Key"),
              value: need("value", "Value"),
              ...(opt("description") ? { description: opt("description") } : {}),
              ...(opt("policy") ? { policy: fields["policy"] } : {}),
            },
          },
        );
        return mapSecret(accountId, clusterId, s);
      }
      case "schedule": {
        const pipeline = opt("pipeline") || parent || need("pipeline", "Pipeline");
        const env = linesToEnv(fields["env"]);
        const s = await bkFetch<BkSchedule>(
          this.ctx,
          `${this.base}/pipelines/${enc(pipeline)}/schedules`,
          {
            method: "POST",
            body: {
              cronline: need("cronline", "Schedule"),
              label: need("label", "Label"),
              ...(opt("branch") ? { branch: opt("branch") } : {}),
              ...(opt("commit") ? { commit: opt("commit") } : {}),
              ...(opt("message") ? { message: opt("message") } : {}),
              ...(Object.keys(env).length > 0 ? { env } : {}),
              enabled: true,
            },
          },
        );
        return mapSchedule(accountId, pipeline, s);
      }
      case "pipeline-template": {
        const t = await bkFetch<BkTemplate>(this.ctx, `${this.base}/pipeline-templates`, {
          method: "POST",
          body: {
            name: need("name", "Name"),
            configuration: need("configuration", "Steps"),
            ...(opt("description") ? { description: opt("description") } : {}),
            available: bool(fields["available"]),
          },
        });
        return mapTemplate(accountId, t);
      }
      case "test-suite": {
        const team = opt("team");
        const s = await bkFetch<BkSuite>(this.ctx, `${this.analytics}/suites`, {
          method: "POST",
          body: {
            name: need("name", "Name"),
            default_branch: need("defaultBranch", "Default branch"),
            ...(opt("applicationName") ? { application_name: opt("applicationName") } : {}),
            ...(team ? { team_ids: [team] } : {}),
          },
        });
        this.suitesCache = undefined;
        return mapSuite(accountId, s, { flakyCount: 0 });
      }
      default:
        throw new Error(`Buildkite plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

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
      case "pipeline": {
        const body = pipelineBody(fields);
        if (Object.keys(body).length > 0) {
          const p = await bkFetch<BkPipeline>(this.ctx, `${this.base}/pipelines/${enc(id)}`, {
            method: "PATCH",
            body,
          });
          this.pipelinesCache = undefined;
          // A rename changes the slug, and with it the resource id.
          return this.getResource(typeId, `${accountId}:pipeline:${p?.slug ?? id}`, accountId);
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "cluster": {
        const body: Record<string, unknown> = {};
        for (const k of ["name", "description", "emoji", "color"]) if (has(k)) body[k] = text(k);
        if (has("hostedGitMirror"))
          body["hosted_git_mirror_enabled"] = bool(fields["hostedGitMirror"]);
        if (has("hostedContainerCache")) {
          body["hosted_container_cache_enabled"] = bool(fields["hostedContainerCache"]);
        }
        if (Object.keys(body).length > 0) {
          await bkFetch(this.ctx, `${this.base}/clusters/${enc(id)}`, { method: "PATCH", body });
          this.clustersCache = undefined;
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "queue": {
        const [clusterId, queueId] = splitFirst(id);
        const body: Record<string, unknown> = {};
        if (has("description")) body["description"] = text("description");
        if (has("retryAgentAffinity") && text("retryAgentAffinity")) {
          body["retry_agent_affinity"] = text("retryAgentAffinity");
        }
        if (has("instanceShape") && text("instanceShape")) {
          body["hostedAgents"] = { instanceShape: text("instanceShape") };
        }
        if (Object.keys(body).length > 0) {
          await bkFetch(
            this.ctx,
            `${this.base}/clusters/${enc(clusterId)}/queues/${enc(queueId)}`,
            {
              method: "PUT",
              body,
            },
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "agent-token": {
        const [clusterId, tokenId] = splitFirst(id);
        const body: Record<string, unknown> = {};
        if (has("description")) body["description"] = text("description");
        if (has("allowedIpAddresses")) body["allowed_ip_addresses"] = text("allowedIpAddresses");
        if (Object.keys(body).length > 0) {
          await bkFetch(
            this.ctx,
            `${this.base}/clusters/${enc(clusterId)}/tokens/${enc(tokenId)}`,
            {
              method: "PUT",
              body,
            },
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "cluster-secret": {
        const [clusterId, secretId] = splitFirst(id);
        const path = `${this.base}/clusters/${enc(clusterId)}/secrets/${enc(secretId)}`;
        const body: Record<string, unknown> = {};
        if (has("description")) body["description"] = text("description");
        if (has("policy")) body["policy"] = fields["policy"] ?? "";
        if (Object.keys(body).length > 0) await bkFetch(this.ctx, path, { method: "PUT", body });
        if (fields["value"]) {
          await bkFetch(this.ctx, `${path}/value`, {
            method: "PUT",
            body: { value: fields["value"] },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "schedule": {
        const [slug, scheduleId] = splitFirst(id);
        const body: Record<string, unknown> = {};
        for (const k of ["label", "cronline", "branch", "commit", "message"]) {
          if (has(k)) body[k] = text(k);
        }
        if (has("env")) body["env"] = linesToEnv(fields["env"]);
        if (has("enabled")) body["enabled"] = bool(fields["enabled"]);
        if (Object.keys(body).length > 0) {
          await bkFetch(
            this.ctx,
            `${this.base}/pipelines/${enc(slug)}/schedules/${enc(scheduleId)}`,
            {
              method: "PUT",
              body,
            },
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "pipeline-template": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = text("name");
        if (has("description")) body["description"] = text("description");
        if (has("available")) body["available"] = bool(fields["available"]);
        if (Object.keys(body).length > 0) {
          await bkFetch(this.ctx, `${this.base}/pipeline-templates/${enc(id)}`, {
            method: "PATCH",
            body,
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "test-suite": {
        const body: Record<string, unknown> = {};
        if (has("name")) body["name"] = text("name");
        if (has("defaultBranch")) body["default_branch"] = text("defaultBranch");
        if (has("applicationName")) body["application_name"] = text("applicationName");
        if (has("emoji")) body["emoji"] = text("emoji");
        if (has("color")) body["color"] = text("color");
        if (Object.keys(body).length > 0) {
          const s = await bkFetch<BkSuite>(this.ctx, `${this.analytics}/suites/${enc(id)}`, {
            method: "PATCH",
            body,
          });
          return this.getResource(typeId, `${accountId}:test-suite:${s?.slug ?? id}`, accountId);
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`Buildkite plugin: cannot edit "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    const del = (path: string) => bkFetch(this.ctx, path, { method: "DELETE" });
    switch (typeId) {
      case "pipeline":
        await del(`${this.base}/pipelines/${enc(id)}`);
        this.pipelinesCache = undefined;
        return;
      case "cluster":
        await del(`${this.base}/clusters/${enc(id)}`);
        this.clustersCache = undefined;
        return;
      case "queue": {
        const [c, q] = splitFirst(id);
        await del(`${this.base}/clusters/${enc(c)}/queues/${enc(q)}`);
        return;
      }
      case "agent-token": {
        const [c, t] = splitFirst(id);
        await del(`${this.base}/clusters/${enc(c)}/tokens/${enc(t)}`);
        return;
      }
      case "cluster-secret": {
        const [c, s] = splitFirst(id);
        await del(`${this.base}/clusters/${enc(c)}/secrets/${enc(s)}`);
        return;
      }
      case "schedule": {
        const [p, s] = splitFirst(id);
        await del(`${this.base}/pipelines/${enc(p)}/schedules/${enc(s)}`);
        return;
      }
      case "pipeline-template":
        await del(`${this.base}/pipeline-templates/${enc(id)}`);
        return;
      case "test-suite":
        await del(`${this.analytics}/suites/${enc(id)}`);
        this.suitesCache = undefined;
        return;
      default:
        throw new Error(`Buildkite plugin: cannot delete "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    const put = (path: string, body?: unknown) =>
      bkFetch(this.ctx, path, { method: "PUT", ...(body !== undefined ? { body } : {}) });
    const post = (path: string, body?: unknown) =>
      bkFetch(this.ctx, path, { method: "POST", ...(body !== undefined ? { body } : {}) });
    switch (typeId) {
      case "pipeline":
        if (actionId === "archive" || actionId === "unarchive") {
          await post(`${this.base}/pipelines/${enc(id)}/${actionId}`);
          this.pipelinesCache = undefined;
          return;
        }
        if (actionId === "add-webhook") {
          await post(`${this.base}/pipelines/${enc(id)}/webhook`);
          return;
        }
        break;
      case "build": {
        const [slug, number] = splitFirst(id);
        const path = `${this.base}/pipelines/${enc(slug)}/builds/${enc(number)}`;
        if (actionId === "cancel" || actionId === "rebuild") {
          await put(`${path}/${actionId}`);
          return;
        }
        if (actionId === "retry-failed") {
          await put(`${path}/retry_failed_jobs`);
          return;
        }
        const [verb, jobId] = actionId.split(":");
        if (jobId && verb === "retry-job") {
          await put(`${this.base}/jobs/${enc(jobId)}/retry`);
          return;
        }
        if (jobId && verb === "unblock-job") {
          await put(`${this.base}/jobs/${enc(jobId)}/unblock`, {});
          return;
        }
        break;
      }
      case "job": {
        const jobId = id.split("/").pop() ?? "";
        if (actionId === "retry") {
          await put(`${this.base}/jobs/${enc(jobId)}/retry`);
          return;
        }
        if (actionId === "unblock") {
          await put(`${this.base}/jobs/${enc(jobId)}/unblock`, {});
          return;
        }
        break;
      }
      case "agent":
        if (actionId === "stop" || actionId === "stop-force") {
          await put(`${this.base}/agents/${enc(id)}/stop`, { force: actionId === "stop-force" });
          return;
        }
        if (actionId === "pause") {
          await put(`${this.base}/agents/${enc(id)}/pause`, {});
          return;
        }
        if (actionId === "resume") {
          await put(`${this.base}/agents/${enc(id)}/resume`, {});
          return;
        }
        break;
      case "queue": {
        const [clusterId, queueId] = splitFirst(id);
        const path = `${this.base}/clusters/${enc(clusterId)}/queues/${enc(queueId)}`;
        if (actionId === "pause-dispatch") {
          await post(`${path}/pause_dispatch`, {});
          return;
        }
        if (actionId === "resume-dispatch") {
          await post(`${path}/resume_dispatch`, {});
          return;
        }
        if (actionId === "make-default") {
          await bkFetch(this.ctx, `${this.base}/clusters/${enc(clusterId)}`, {
            method: "PATCH",
            body: { default_queue_id: queueId },
          });
          return;
        }
        break;
      }
      case "schedule":
        if (actionId === "enable" || actionId === "disable") {
          const [slug, scheduleId] = splitFirst(id);
          await put(`${this.base}/pipelines/${enc(slug)}/schedules/${enc(scheduleId)}`, {
            enabled: actionId === "enable",
          });
          return;
        }
        break;
      case "test":
        if (actionId === "mute" || actionId === "skip" || actionId === "enable") {
          const [suite, testId] = splitFirst(id);
          await put(`${this.analytics}/suites/${enc(suite)}/tests/${enc(testId)}/${actionId}`);
          return;
        }
        break;
    }
    throw new Error(`Buildkite plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async executeNoSqlCommand(
    typeId: string,
    resourceId: string,
    _accountId: string,
    command: string,
    args: (string | number)[],
  ): Promise<unknown> {
    const id = externalIdOf(resourceId);
    const vals = parseFormArg(args[0]);
    switch (command) {
      case "moveToCluster":
        if (typeId !== "pipeline") break;
        if (!vals["clusterId"]) throw new Error("Buildkite plugin: choose a cluster");
        await bkFetch(this.ctx, `${this.base}/pipelines/${enc(id)}`, {
          method: "PATCH",
          body: { cluster_id: vals["clusterId"] },
        });
        this.pipelinesCache = undefined;
        return null;
      case "setDefaultQueue":
        if (typeId !== "cluster") break;
        if (!vals["queueId"]) throw new Error("Buildkite plugin: choose a queue");
        await bkFetch(this.ctx, `${this.base}/clusters/${enc(id)}`, {
          method: "PATCH",
          body: { default_queue_id: vals["queueId"] },
        });
        return null;
      case "pauseQueue": {
        if (typeId !== "queue") break;
        const [clusterId, queueId] = splitFirst(id);
        const note = (vals["note"] ?? "").trim();
        await bkFetch(
          this.ctx,
          `${this.base}/clusters/${enc(clusterId)}/queues/${enc(queueId)}/pause_dispatch`,
          { method: "POST", body: note ? { note } : {} },
        );
        return null;
      }
      case "pauseAgent": {
        if (typeId !== "agent") break;
        const note = (vals["note"] ?? "").trim();
        const timeout = Number((vals["timeoutMinutes"] ?? "").trim() || "0");
        if (timeout && (!Number.isInteger(timeout) || timeout < 1 || timeout > 10080)) {
          throw new Error("Buildkite plugin: the pause timeout is 1 to 10080 minutes");
        }
        await bkFetch(this.ctx, `${this.base}/agents/${enc(id)}/pause`, {
          method: "PUT",
          body: { ...(note ? { note } : {}), ...(timeout ? { timeout_in_minutes: timeout } : {}) },
        });
        return null;
      }
      case "reprioritize": {
        if (typeId !== "job") break;
        const priority = Number((vals["priority"] ?? "").trim());
        if (!Number.isInteger(priority))
          throw new Error("Buildkite plugin: priority must be a whole number");
        const jobId = id.split("/").pop() ?? "";
        await bkFetch(this.ctx, `${this.base}/jobs/${enc(jobId)}/reprioritize`, {
          method: "PUT",
          body: { priority },
        });
        return null;
      }
    }
    throw new Error(`Buildkite plugin: unknown command "${command}" for "${typeId}"`);
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "cluster" || formatId !== "agent-token") {
      throw new Error(`Buildkite plugin: cannot export "${formatId}" for "${typeId}"`);
    }
    const clusterId = externalIdOf(resourceId);
    const t = await bkFetch<BkAgentToken>(
      this.ctx,
      `${this.base}/clusters/${enc(clusterId)}/tokens`,
      {
        method: "POST",
        body: { description: `Infrawrench ${new Date().toISOString().slice(0, 10)}` },
      },
    );
    if (!t.token) throw new Error("Buildkite did not return the new agent token");
    return {
      content: t.token,
      filename: "buildkite-agent-token.txt",
      mimeType: "text/plain",
      fields: [
        { label: "Token", value: t.token, sensitive: true, hint: "Only shown once" },
        { label: "Description", value: t.description ?? "" },
      ],
      warning:
        "Save this token now: Buildkite does not show it again. Set it as BUILDKITE_AGENT_TOKEN (or token= in buildkite-agent.cfg) on the agents for this cluster.",
    };
  }

  // -------------------------------------------------------------------------
  // Preflight
  // -------------------------------------------------------------------------

  async verifyCredentials(): Promise<PreflightResult> {
    let token: {
      scopes?: string[];
      description?: string;
      user?: { email?: string; name?: string };
    };
    try {
      token = await bkFetch(this.ctx, "/access-token");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        checks: PREFLIGHT_CAPABILITIES.map<PreflightCapabilityCheck>((c) => ({
          capabilityId: c.id,
          status: "unknown",
          message,
        })),
      };
    }
    const granted = new Set(token.scopes ?? []);
    const checks = PREFLIGHT_CAPABILITIES.map<PreflightCapabilityCheck>((c) => {
      const missing = c.requiredPermissions.filter((p) => !granted.has(p.id));
      return missing.length === 0
        ? { capabilityId: c.id, status: "ok" }
        : {
            capabilityId: c.id,
            status: "missing",
            missingPermissions: missing,
            helpLink: {
              label: "API access tokens",
              url: "https://buildkite.com/user/api-access-tokens",
            },
          };
    });
    const who = token.user?.email ?? token.user?.name;
    return {
      checks,
      ...(who ? { identity: `${who}${token.description ? ` (${token.description})` : ""}` } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderBuildkiteDetail(resource);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderBuildkiteSidebar(resource);
  }
}

export { isPermissionError };
