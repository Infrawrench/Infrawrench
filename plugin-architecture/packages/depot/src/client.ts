import type {
  ActionNode,
  CostFetchRange,
  CostRow,
  CreateResourceConfig,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  KVItem,
  MetricSeries,
  PluginClient,
  QuotaUsage,
  ResourceInstance,
  ResourceStatus,
  SectionNode,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf, joinSubtitle } from "@infrawrench/plugin-base";
import {
  RPC,
  connectCall,
  getUsage,
  listAllPages,
  mapLimit,
  type DepotTransport,
  type WireBuild,
  type WireImage,
  type WireProject,
  type WireProjectUsage,
  type WireToken,
  type WireTrustPolicy,
} from "./api.js";
import { fetchDepotCostData, normalizeUsage, type DayUsage } from "./cost-data.js";
import {
  DEPOT_REGIONS,
  HARDWARE_OPTIONS,
  hardwareFromWire,
  hardwareLabel,
  hardwareToWire,
} from "./hardware.js";
import { DEPOT_METRICS_CAPABILITY, fetchProjectMetrics, fetchRepoMetrics } from "./metrics.js";
import { fetchDepotQuotas } from "./quotas.js";
import { cycleBounds, resolveRates, type ResolvedRates } from "./rates.js";
import {
  ACTIONS_REPO_TYPE,
  BUILD_TYPE,
  IMAGE_TYPE,
  PROJECT_TYPE,
  TOKEN_TYPE,
  TRUST_POLICY_TYPE,
} from "./resource-types.js";

const PLUGIN_ID = "depot";
const DAY_MS = 86_400_000;
/** Builds listed per project: the recent history, not the archive. */
const RECENT_BUILDS = 25;
/** Image tags listed per project. */
const MAX_IMAGES = 200;
const CONCURRENCY = 4;
const RESET_CACHE_ACTION = "reset-cache";
/** Depot redirects `_` to the signed-in user's current organization. */
const DASHBOARD_URL = "https://depot.dev/orgs/_/projects";

const BUILD_STATUS: Record<string, string> = {
  STATUS_RUNNING: "running",
  STATUS_SUCCESS: "success",
  STATUS_FAILED: "failed",
  STATUS_ERROR: "error",
  STATUS_CANCELED: "canceled",
};

/** Usage summaries ride on the resource for the synchronous renderer. */
const ACTIONS_STASH_KEY = "__actions__";

const TRUST_PROVIDERS = [
  { id: "github", label: "GitHub Actions" },
  { id: "circleci", label: "CircleCI" },
  { id: "buildkite", label: "Buildkite" },
  { id: "gitlab", label: "GitLab CI" },
] as const;

/** `projectId/childId`: children keep their project so reads and deletes can address it. */
function childId(projectId: string, id: string): string {
  return `${projectId}/${id}`;
}

function splitChildId(externalId: string): { projectId: string; id: string } {
  const slash = externalId.indexOf("/");
  return slash === -1
    ? { projectId: "", id: externalId }
    : { projectId: externalId.slice(0, slash), id: externalId.slice(slash + 1) };
}

function buildStatus(status: string): ResourceStatus {
  switch (status) {
    case "success":
      return "healthy";
    case "running":
      return "provisioning";
    case "failed":
    case "error":
      return "error";
    case "canceled":
      return "degraded";
    default:
      return "unknown";
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatGb(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / 1_000_000;
  return mb >= 1000 ? `${(mb / 1000).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

function trustSubject(policy: WireTrustPolicy): { provider: string; subject: string } {
  if (policy.github) {
    return {
      provider: "github",
      subject: `${policy.github.repositoryOwner ?? ""}/${policy.github.repository ?? ""}`,
    };
  }
  if (policy.circleci) {
    return {
      provider: "circleci",
      subject: `org ${policy.circleci.organizationUuid ?? ""}, project ${policy.circleci.projectUuid ?? ""}`,
    };
  }
  if (policy.buildkite) {
    return {
      provider: "buildkite",
      subject: `${policy.buildkite.organizationSlug ?? ""}/${policy.buildkite.pipelineSlug ?? ""}`,
    };
  }
  if (policy.gitlab) {
    return {
      provider: "gitlab",
      subject: `${policy.gitlab.namespaceId ?? ""}/${policy.gitlab.projectId ?? ""}`,
    };
  }
  return { provider: "unknown", subject: "" };
}

const kv = (key: string, value: unknown, copyable = false): KVItem[] =>
  value === undefined || value === null || value === ""
    ? []
    : [{ key, value: String(value), ...(copyable ? { copyable: true } : {}) }];

/**
 * Depot plugin client. Everything goes through Depot's Connect API with an
 * organization token; see `api.ts` for the transport and wire shapes.
 */
export class DepotClient implements PluginClient {
  private readonly transport: DepotTransport;
  private readonly pricing: ResolvedRates;
  private projectCache: Promise<WireProject[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["token"] ?? "").trim();
    if (!token) throw new Error("Depot plugin: missing organization token");
    this.transport = {
      token,
      http: services?.http,
      caCert: credentials["caCert"] || undefined,
    };
    this.pricing = resolveRates(credentials["plan"], credentials["rateOverrides"]);
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                    */
  /* ---------------------------------------------------------------------- */

  /** Every project, memoised for the life of the client (one sync pass). */
  private projects(): Promise<WireProject[]> {
    this.projectCache ??= listAllPages<
      WireProject,
      { projects?: WireProject[]; nextPageToken?: string }
    >(this.transport, RPC.listProjects, {}, (r) => r.projects, { pageSize: 100 }).catch((err) => {
      this.projectCache = undefined;
      throw err;
    });
    return this.projectCache;
  }

  private async projectUsage(): Promise<Map<string, WireProjectUsage>> {
    const endMs = Date.now();
    const usage = await listAllPages<
      WireProjectUsage,
      { usage?: WireProjectUsage[]; nextPageToken?: string }
    >(
      this.transport,
      RPC.listProjectUsage,
      {
        startAt: new Date(endMs - 30 * DAY_MS).toISOString(),
        endAt: new Date(endMs).toISOString(),
      },
      (r) => r.usage,
      { pageSize: 100 },
    ).catch(() => [] as WireProjectUsage[]);
    return new Map(usage.map((u) => [u.projectId ?? "", u]));
  }

  /** Run `fn` per project and flatten, at most a few projects in flight. */
  private async perProject<T>(fn: (project: WireProject) => Promise<T[]>): Promise<T[]> {
    const projects = await this.projects();
    const results = await mapLimit(projects, CONCURRENCY, fn);
    return results.flat();
  }

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    switch (typeId) {
      case PROJECT_TYPE: {
        const [projects, usage] = await Promise.all([this.projects(), this.projectUsage()]);
        return projects.map((p) => this.mapProject(p, accountId, usage.get(p.projectId ?? "")));
      }
      case BUILD_TYPE:
        return this.perProject(async (p) => {
          const res = await connectCall<{ builds?: WireBuild[] }>(this.transport, RPC.listBuilds, {
            projectId: p.projectId,
            pageSize: RECENT_BUILDS,
          });
          return (res.builds ?? []).map((b) => this.mapBuild(b, p.projectId ?? "", accountId));
        });
      case TOKEN_TYPE:
        return this.perProject(async (p) => {
          const res = await connectCall<{ tokens?: WireToken[] }>(this.transport, RPC.listTokens, {
            projectId: p.projectId,
          });
          return (res.tokens ?? []).map((t) => this.mapToken(t, p.projectId ?? "", accountId));
        });
      case TRUST_POLICY_TYPE:
        return this.perProject(async (p) => {
          const res = await connectCall<{ trustPolicies?: WireTrustPolicy[] }>(
            this.transport,
            RPC.listTrustPolicies,
            { projectId: p.projectId },
          );
          return (res.trustPolicies ?? []).map((t) =>
            this.mapTrustPolicy(t, p.projectId ?? "", accountId),
          );
        });
      case IMAGE_TYPE:
        return this.perProject(async (p) => {
          const images = await listAllPages<
            WireImage,
            { images?: WireImage[]; nextPageToken?: string }
          >(this.transport, RPC.listImages, { projectId: p.projectId }, (r) => r.images, {
            pageSize: 100,
            maxPages: Math.ceil(MAX_IMAGES / 100),
          }).catch(() => [] as WireImage[]);
          return images.map((i) => this.mapImage(i, p.projectId ?? "", accountId));
        });
      case ACTIONS_REPO_TYPE:
        return this.listActionsRepos(accountId);
      default:
        throw new Error(`Depot plugin: unknown resource type "${typeId}"`);
    }
  }

  /** The current billing cycle's usage, from its first day to now. */
  private async cycleUsage(): Promise<{ startMs: number; usage: DayUsage }> {
    const now = new Date();
    const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const { startMs } = cycleBounds(todayMs, this.pricing.rates.cycleStartDay);
    const usage = normalizeUsage(await getUsage(this.transport, startMs, now.getTime()));
    return { startMs, usage };
  }

  private async listActionsRepos(accountId: string): Promise<ResourceInstance[]> {
    const { startMs, usage } = await this.cycleUsage();
    const byRepo = new Map<string, DayUsage["actions"]>();
    for (const row of usage.actions) {
      if (!row.repo) continue;
      byRepo.set(row.repo, [...(byRepo.get(row.repo) ?? []), row]);
    }
    return [...byRepo.entries()].map(([repo, rows]) =>
      this.mapActionsRepo(repo, rows, startMs, accountId),
    );
  }

  async getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    if (typeId === PROJECT_TYPE) {
      const [res, usage] = await Promise.all([
        connectCall<{ project?: WireProject }>(this.transport, RPC.getProject, {
          projectId: externalId,
        }),
        this.projectUsage(),
      ]);
      if (!res.project) throw new Error(`Depot plugin: project ${externalId} not found`);
      return this.mapProject(res.project, accountId, usage.get(externalId));
    }
    if (typeId === BUILD_TYPE) {
      const { projectId, id } = splitChildId(externalId);
      const res = await connectCall<{ build?: WireBuild }>(this.transport, RPC.getBuild, {
        buildId: id,
      });
      if (!res.build) throw new Error(`Depot plugin: build ${id} not found`);
      return this.mapBuild(res.build, projectId, accountId);
    }
    const all = await this.listResources(typeId, accountId);
    const found = all.find((r) => r.id === resourceId);
    if (!found) throw new Error(`Depot plugin: resource ${typeId}/${resourceId} not found`);
    return found;
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const externalId = externalIdOf(resourceId);
    if (typeId === PROJECT_TYPE) {
      if (outputKey === "projectId") return externalId;
      if (outputKey === "registryRepository") return `registry.depot.dev/${externalId}`;
    }
    if (typeId === BUILD_TYPE && outputKey === "buildId") return splitChildId(externalId).id;
    if (typeId === TOKEN_TYPE && outputKey === "tokenId") return splitChildId(externalId).id;
    if (typeId === TRUST_POLICY_TYPE && outputKey === "trustPolicyId") {
      return splitChildId(externalId).id;
    }
    const resource = await this.getResource(typeId, resourceId, accountId);
    const value = resource.resolvedOutputs[outputKey];
    if (value !== undefined) return value;
    throw new Error(`Depot plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  /* ---------------------------------------------------------------------- */
  /* Mapping                                                                  */
  /* ---------------------------------------------------------------------- */

  private instance(
    typeId: string,
    externalId: string,
    accountId: string,
    displayName: string,
    fields: ResourceInstance["fields"],
    resolvedOutputs: Record<string, string>,
    extra: { createdAt?: string | undefined; parentProjectId?: string } = {},
  ): ResourceInstance {
    const at = extra.createdAt || new Date().toISOString();
    return {
      id: `${accountId}:${typeId}:${externalId}`,
      pluginId: PLUGIN_ID,
      resourceTypeId: typeId,
      accountId,
      displayName,
      fields,
      resolvedOutputs,
      secretStates: [],
      externalId,
      ...(extra.parentProjectId
        ? { parentResourceId: `${accountId}:${PROJECT_TYPE}:${extra.parentProjectId}` }
        : {}),
      createdAt: at,
      updatedAt: at,
    };
  }

  private mapProject(
    p: WireProject,
    accountId: string,
    usage?: WireProjectUsage,
  ): ResourceInstance {
    const id = p.projectId ?? "";
    const name = p.name || id;
    const fields: ResourceInstance["fields"] = {
      projectId: id,
      name,
      regionId: p.regionId ?? "",
      hardware: hardwareFromWire(p.hardware),
      cacheKeepGb: p.cachePolicy?.keepGb ?? 0,
      cacheKeepDays: p.cachePolicy?.keepDays ?? 0,
      organizationId: p.organizationId ?? "",
      createdAt: p.createdAt ?? "",
    };
    if (usage) {
      fields["builds30d"] = usage.buildCount ?? 0;
      fields["buildMinutes30d"] = Number(((usage.buildDurationSeconds ?? 0) / 60).toFixed(1));
      fields["layerCacheGb"] = usage.layerCacheSizeGb ?? 0;
    }
    return this.instance(
      PROJECT_TYPE,
      id,
      accountId,
      name,
      fields,
      { projectId: id, projectName: name, registryRepository: `registry.depot.dev/${id}` },
      { createdAt: p.createdAt },
    );
  }

  private mapBuild(b: WireBuild, projectId: string, accountId: string): ResourceInstance {
    const id = b.buildId ?? "";
    const status = BUILD_STATUS[b.status ?? ""] ?? "unknown";
    const fields: ResourceInstance["fields"] = {
      buildId: id,
      projectId,
      status,
      createdAt: b.createdAt ?? "",
      startedAt: b.startedAt ?? "",
      finishedAt: b.finishedAt ?? "",
    };
    if (b.buildDurationSeconds !== undefined) fields["durationSeconds"] = b.buildDurationSeconds;
    if (b.savedDurationSeconds !== undefined) fields["savedSeconds"] = b.savedDurationSeconds;
    if (b.cachedSteps !== undefined) fields["cachedSteps"] = b.cachedSteps;
    if (b.totalSteps !== undefined) fields["totalSteps"] = b.totalSteps;
    if ((b.totalSteps ?? 0) > 0) {
      fields["cacheHitRate"] = Number((((b.cachedSteps ?? 0) / b.totalSteps!) * 100).toFixed(1));
    }
    return this.instance(
      BUILD_TYPE,
      childId(projectId, id),
      accountId,
      id,
      fields,
      { buildId: id },
      { createdAt: b.createdAt, parentProjectId: projectId },
    );
  }

  private mapToken(t: WireToken, projectId: string, accountId: string): ResourceInstance {
    const id = t.tokenId ?? "";
    return this.instance(
      TOKEN_TYPE,
      childId(projectId, id),
      accountId,
      t.description || id,
      { tokenId: id, description: t.description ?? "", projectId },
      { tokenId: id },
      { parentProjectId: projectId },
    );
  }

  private mapTrustPolicy(
    t: WireTrustPolicy,
    projectId: string,
    accountId: string,
  ): ResourceInstance {
    const id = t.trustPolicyId ?? "";
    const { provider, subject } = trustSubject(t);
    const label = TRUST_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
    return this.instance(
      TRUST_POLICY_TYPE,
      childId(projectId, id),
      accountId,
      `${label}: ${subject}`,
      { trustPolicyId: id, provider, subject, projectId },
      { trustPolicyId: id },
      { parentProjectId: projectId },
    );
  }

  private mapImage(i: WireImage, projectId: string, accountId: string): ResourceInstance {
    const tag = i.tag ?? "";
    const size = Number(i.sizeBytes ?? 0);
    return this.instance(
      IMAGE_TYPE,
      childId(projectId, tag),
      accountId,
      tag,
      {
        tag,
        digest: i.digest ?? "",
        pushedAt: i.pushedAt ?? "",
        sizeBytes: Number.isFinite(size) ? size : 0,
        projectId,
      },
      { imageRef: `registry.depot.dev/${projectId}:${tag}`, digest: i.digest ?? "" },
      { createdAt: i.pushedAt, parentProjectId: projectId },
    );
  }

  private mapActionsRepo(
    repo: string,
    rows: DayUsage["actions"],
    cycleStartMs: number,
    accountId: string,
  ): ResourceInstance {
    const sum = (k: "jobs" | "elapsed" | "billed") => rows.reduce((s, r) => s + r[k], 0);
    const cycleStart = new Date(cycleStartMs).toISOString().slice(0, 10);
    return this.instance(
      ACTIONS_REPO_TYPE,
      repo,
      accountId,
      repo,
      {
        repo,
        jobs: sum("jobs"),
        minutesElapsed: Number(sum("elapsed").toFixed(1)),
        minutesBilled: Number(sum("billed").toFixed(1)),
        cycleStart,
      },
      { repo, [ACTIONS_STASH_KEY]: JSON.stringify(rows) },
      { createdAt: new Date(cycleStartMs).toISOString() },
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Dashboard, metrics, cost, quotas                                         */
  /* ---------------------------------------------------------------------- */

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    switch (resourceTypeId) {
      case PROJECT_TYPE:
        return [
          { label: "Region", value: String(f["regionId"] || "-") },
          { label: "Builds (30d)", value: String(f["builds30d"] ?? 0) },
          { label: "Build minutes (30d)", value: String(f["buildMinutes30d"] ?? 0) },
          { label: "Cache used", value: `${String(f["layerCacheGb"] ?? 0)} GB` },
        ];
      case BUILD_TYPE: {
        const status = String(f["status"] ?? "");
        return [
          {
            label: "Status",
            value: status,
            variant:
              status === "success"
                ? "status-healthy"
                : status === "failed" || status === "error"
                  ? "status-error"
                  : "default",
          },
          { label: "Duration", value: formatDuration(Number(f["durationSeconds"] ?? 0)) },
          { label: "Cache hit rate", value: `${String(f["cacheHitRate"] ?? 0)}%` },
        ];
      }
      case ACTIONS_REPO_TYPE:
        return [
          { label: "Jobs", value: String(f["jobs"] ?? 0) },
          { label: "Billed minutes", value: String(f["minutesBilled"] ?? 0) },
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
    const externalId = externalIdOf(resourceId);
    if (resourceTypeId === PROJECT_TYPE) {
      return fetchProjectMetrics(this.transport, externalId, timeRange);
    }
    if (resourceTypeId === ACTIONS_REPO_TYPE) {
      return fetchRepoMetrics(this.transport, externalId, timeRange);
    }
    return [];
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    return fetchDepotCostData(
      {
        transport: this.transport,
        rates: this.pricing.rates,
        projectIdsByName: async () =>
          new Map((await this.projects()).map((p) => [p.name ?? "", p.projectId ?? ""])),
      },
      range,
    );
  }

  async fetchQuotas(_accountId: string): Promise<QuotaUsage[]> {
    return fetchDepotQuotas(this.transport, this.pricing.rates);
  }

  /* ---------------------------------------------------------------------- */
  /* Mutations                                                                */
  /* ---------------------------------------------------------------------- */

  private async projectOptions(): Promise<Array<{ id: string; label: string }>> {
    const projects = await this.projects().catch(() => [] as WireProject[]);
    return projects.map((p) => ({ id: p.projectId ?? "", label: p.name || (p.projectId ?? "") }));
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const projectPicker = async (): Promise<CreateResourceConfig["fields"]> => {
      if (parentResourceId) return [];
      const options = await this.projectOptions();
      return [
        {
          key: "projectId",
          label: "Project",
          kind: "select",
          required: true,
          options,
          ...(options[0] ? { defaultValue: options[0].id } : {}),
        },
      ];
    };

    if (typeId === PROJECT_TYPE) {
      return {
        fields: [
          { key: "name", label: "Name", kind: "text", required: true },
          {
            key: "regionId",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions: DEPOT_REGIONS,
            defaultValue: "us-east-1",
          },
          {
            key: "hardware",
            label: "Builder size",
            kind: "select",
            required: false,
            options: HARDWARE_OPTIONS.map((h) => ({ id: h.value, label: h.label })),
            defaultValue: "default",
            description: "Larger builders are billed at a higher rate on some plans.",
          },
          {
            key: "cacheKeepGb",
            label: "Cache size limit (GB)",
            kind: "number",
            required: false,
            defaultValue: "50",
            minValue: 1,
            description: "Layer cache kept per architecture before the oldest entries are evicted.",
          },
          {
            key: "cacheKeepDays",
            label: "Cache retention (days)",
            kind: "number",
            required: false,
            defaultValue: "14",
            minValue: 0,
            description: "Entries unused for this many days are evicted. 0 keeps them.",
          },
        ],
      };
    }

    if (typeId === TOKEN_TYPE) {
      return {
        fields: [
          ...(await projectPicker()),
          {
            key: "description",
            label: "Description",
            kind: "text",
            required: true,
            placeholder: "GitHub Actions deploy",
          },
        ],
      };
    }

    if (typeId === TRUST_POLICY_TYPE) {
      const when = (provider: string) => ({ fieldKey: "provider", fieldValue: provider });
      return {
        fields: [
          ...(await projectPicker()),
          {
            key: "provider",
            label: "CI provider",
            kind: "select",
            required: true,
            options: TRUST_PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
            defaultValue: "github",
          },
          {
            key: "repositoryOwner",
            label: "Repository owner",
            kind: "text",
            required: true,
            description: "The GitHub user or organization that owns the repository.",
            showWhen: when("github"),
          },
          {
            key: "repository",
            label: "Repository name",
            kind: "text",
            required: true,
            showWhen: when("github"),
          },
          {
            key: "organizationUuid",
            label: "CircleCI organization ID",
            kind: "text",
            required: true,
            description: "Organization Settings, Overview, Organization ID in CircleCI.",
            showWhen: when("circleci"),
          },
          {
            key: "projectUuid",
            label: "CircleCI project ID",
            kind: "text",
            required: true,
            description: "Project Settings, Overview, Project ID in CircleCI.",
            showWhen: when("circleci"),
          },
          {
            key: "organizationSlug",
            label: "Buildkite organization slug",
            kind: "text",
            required: true,
            showWhen: when("buildkite"),
          },
          {
            key: "pipelineSlug",
            label: "Buildkite pipeline slug",
            kind: "text",
            required: true,
            showWhen: when("buildkite"),
          },
          {
            key: "namespaceId",
            label: "GitLab group or user",
            kind: "text",
            required: true,
            showWhen: when("gitlab"),
          },
          {
            key: "gitlabProject",
            label: "GitLab project",
            kind: "text",
            required: true,
            showWhen: when("gitlab"),
          },
        ],
      };
    }

    throw new Error(`Depot plugin: no create config for type "${typeId}"`);
  }

  private cachePolicy(fields: Record<string, string>): Record<string, number> | undefined {
    const gb = Number(fields["cacheKeepGb"]);
    const days = Number(fields["cacheKeepDays"]);
    const hasGb = fields["cacheKeepGb"] !== undefined && fields["cacheKeepGb"] !== "";
    const hasDays = fields["cacheKeepDays"] !== undefined && fields["cacheKeepDays"] !== "";
    if (!hasGb && !hasDays) return undefined;
    if (
      (hasGb && (!Number.isInteger(gb) || gb < 1)) ||
      (hasDays && (!Number.isInteger(days) || days < 0))
    ) {
      throw new Error(
        "Depot plugin: cache size must be a whole number of GB (1 or more) and retention whole days",
      );
    }
    return { ...(hasGb ? { keepGb: gb } : {}), ...(hasDays ? { keepDays: days } : {}) };
  }

  private projectOf(fields: Record<string, string>, parentResourceId?: string): string {
    const projectId = parentResourceId
      ? externalIdOf(parentResourceId)
      : (fields["projectId"] ?? "").trim();
    if (!projectId) throw new Error("Depot plugin: pick the project");
    return projectId;
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    if (typeId === PROJECT_TYPE) {
      const name = (fields["name"] ?? "").trim();
      if (!name) throw new Error("Depot plugin: a project name is required");
      const hardware = hardwareToWire(fields["hardware"]);
      const cachePolicy = this.cachePolicy(fields);
      const res = await connectCall<{ project?: WireProject }>(this.transport, RPC.createProject, {
        name,
        regionId: fields["regionId"] || "us-east-1",
        ...(cachePolicy ? { cachePolicy } : {}),
        ...(hardware ? { hardware } : {}),
      });
      this.projectCache = undefined;
      if (!res.project) throw new Error("Depot plugin: Depot did not return the new project");
      return this.mapProject(res.project, accountId);
    }

    if (typeId === TOKEN_TYPE) {
      const projectId = this.projectOf(fields, parentResourceId);
      const description = (fields["description"] ?? "").trim();
      if (!description) throw new Error("Depot plugin: a token description is required");
      const res = await connectCall<{ tokenId?: string; secret?: string }>(
        this.transport,
        RPC.createToken,
        { projectId, description },
      );
      const instance = this.mapToken(
        { tokenId: res.tokenId ?? "", description },
        projectId,
        accountId,
      );
      // The secret is returned exactly once, on this response.
      if (res.secret) instance.resolvedOutputs["token"] = res.secret;
      return instance;
    }

    if (typeId === TRUST_POLICY_TYPE) {
      const projectId = this.projectOf(fields, parentResourceId);
      const v = (k: string) => (fields[k] ?? "").trim();
      const need = (...keys: string[]) => {
        const missing = keys.filter((k) => !v(k));
        if (missing.length > 0)
          throw new Error("Depot plugin: fill in every field for this CI provider");
      };
      let policy: Record<string, unknown>;
      switch (fields["provider"]) {
        case "circleci":
          need("organizationUuid", "projectUuid");
          policy = {
            circleci: { organizationUuid: v("organizationUuid"), projectUuid: v("projectUuid") },
          };
          break;
        case "buildkite":
          need("organizationSlug", "pipelineSlug");
          policy = {
            buildkite: { organizationSlug: v("organizationSlug"), pipelineSlug: v("pipelineSlug") },
          };
          break;
        case "gitlab":
          need("namespaceId", "gitlabProject");
          policy = { gitlab: { namespaceId: v("namespaceId"), projectId: v("gitlabProject") } };
          break;
        default:
          need("repositoryOwner", "repository");
          policy = {
            github: { repositoryOwner: v("repositoryOwner"), repository: v("repository") },
          };
      }
      const res = await connectCall<{ trustPolicy?: WireTrustPolicy }>(
        this.transport,
        RPC.addTrustPolicy,
        { projectId, ...policy },
      );
      return this.mapTrustPolicy(res.trustPolicy ?? policy, projectId, accountId);
    }

    throw new Error(`Depot plugin: cannot create type "${typeId}"`);
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const externalId = externalIdOf(resourceId);
    if (typeId === PROJECT_TYPE) {
      const body: Record<string, unknown> = { projectId: externalId };
      const name = (fields["name"] ?? "").trim();
      if (name) body["name"] = name;
      if (fields["regionId"]) body["regionId"] = fields["regionId"];
      const hardware =
        fields["hardware"] !== undefined ? hardwareToWire(fields["hardware"]) : undefined;
      if (fields["hardware"] !== undefined) body["hardware"] = hardware ?? "HARDWARE_UNSPECIFIED";
      const cachePolicy = this.cachePolicy(fields);
      if (cachePolicy) body["cachePolicy"] = cachePolicy;
      const res = await connectCall<{ project?: WireProject }>(
        this.transport,
        RPC.updateProject,
        body,
      );
      this.projectCache = undefined;
      return res.project
        ? this.mapProject(res.project, accountId)
        : this.getResource(typeId, resourceId, accountId);
    }
    if (typeId === TOKEN_TYPE) {
      const { projectId, id } = splitChildId(externalId);
      const description = (fields["description"] ?? "").trim();
      if (!description) throw new Error("Depot plugin: a token description is required");
      await connectCall(this.transport, RPC.updateToken, { tokenId: id, description });
      return this.mapToken({ tokenId: id, description }, projectId, accountId);
    }
    throw new Error(`Depot plugin: cannot update type "${typeId}"`);
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const externalId = externalIdOf(resourceId);
    switch (typeId) {
      case PROJECT_TYPE:
        await connectCall(this.transport, RPC.deleteProject, { projectId: externalId });
        this.projectCache = undefined;
        return;
      case TOKEN_TYPE:
        await connectCall(this.transport, RPC.deleteToken, {
          tokenId: splitChildId(externalId).id,
        });
        return;
      case TRUST_POLICY_TYPE: {
        const { projectId, id } = splitChildId(externalId);
        await connectCall(this.transport, RPC.removeTrustPolicy, {
          projectId,
          trustPolicyId: id,
        });
        return;
      }
      case IMAGE_TYPE: {
        const { projectId, id } = splitChildId(externalId);
        await connectCall(this.transport, RPC.deleteImage, { projectId, imageTags: [id] });
        return;
      }
      default:
        throw new Error(`Depot plugin: cannot delete type "${typeId}"`);
    }
  }

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    if (typeId === PROJECT_TYPE && actionId === RESET_CACHE_ACTION) {
      await connectCall(this.transport, RPC.resetProject, { projectId: externalIdOf(resourceId) });
      return;
    }
    throw new Error(`Depot plugin: unknown action "${actionId}" on "${typeId}"`);
  }

  /* ---------------------------------------------------------------------- */
  /* Rendering                                                                */
  /* ---------------------------------------------------------------------- */

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    switch (resource.resourceTypeId) {
      case PROJECT_TYPE:
        return this.renderProject(resource);
      case BUILD_TYPE:
        return this.renderBuild(resource);
      case TOKEN_TYPE:
        return this.renderSimple(resource, "Project token", [
          ...kv("Token ID", resource.fields["tokenId"], true),
          ...kv("Description", resource.fields["description"]),
          ...kv("Project", resource.fields["projectId"], true),
          ...kv(
            "Token",
            resource.resolvedOutputs["token"] ? "Shown once, copy it from Outputs" : "",
          ),
        ]);
      case TRUST_POLICY_TYPE:
        return this.renderSimple(resource, "Trust relationship", [
          ...kv(
            "CI provider",
            TRUST_PROVIDERS.find((p) => p.id === resource.fields["provider"])?.label ??
              resource.fields["provider"],
          ),
          ...kv("Trusted source", resource.fields["subject"], true),
          ...kv("Trust policy ID", resource.fields["trustPolicyId"], true),
          ...kv("Project", resource.fields["projectId"], true),
        ]);
      case IMAGE_TYPE:
        return this.renderSimple(resource, "Registry image", [
          ...kv("Tag", resource.fields["tag"], true),
          ...kv("Image", resource.resolvedOutputs["imageRef"], true),
          ...kv("Digest", resource.fields["digest"], true),
          ...kv("Size", formatGb(Number(resource.fields["sizeBytes"] ?? 0))),
          ...kv("Pushed", resource.fields["pushedAt"]),
        ]);
      case ACTIONS_REPO_TYPE:
        return this.renderActionsRepo(resource);
      default:
        return this.renderSimple(resource, resource.resourceTypeId, []);
    }
  }

  private renderSimple(
    resource: ResourceInstance,
    subtitle: string,
    items: KVItem[],
  ): DetailViewSchema {
    return {
      title: resource.displayName,
      subtitle,
      sections: [
        { kind: "section", title: "Details", children: [{ kind: "key-value-list", items }] },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderProject(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const sections: SectionNode[] = [
      {
        kind: "section",
        title: "Project",
        children: [
          {
            kind: "key-value-list",
            items: [
              ...kv("Project ID", f["projectId"], true),
              ...kv("Region", f["regionId"]),
              ...kv("Builder size", hardwareLabel(String(f["hardware"] ?? "default"))),
              ...kv("Registry", resource.resolvedOutputs["registryRepository"], true),
              ...kv("Created", f["createdAt"]),
            ],
          },
        ],
      },
      {
        kind: "section",
        title: "Cache",
        children: [
          {
            kind: "key-value-list",
            items: [
              ...kv(
                "Layer cache used",
                f["layerCacheGb"] !== undefined ? `${String(f["layerCacheGb"])} GB` : "",
              ),
              ...kv(
                "Size limit",
                Number(f["cacheKeepGb"] ?? 0) > 0
                  ? `${String(f["cacheKeepGb"])} GB`
                  : "Depot default",
              ),
              ...kv(
                "Retention",
                Number(f["cacheKeepDays"] ?? 0) > 0
                  ? `${String(f["cacheKeepDays"])} days`
                  : "No age limit",
              ),
            ],
          },
        ],
      },
    ];
    if (f["builds30d"] !== undefined) {
      sections.push({
        kind: "section",
        title: "Last 30 days",
        children: [
          {
            kind: "key-value-list",
            items: [...kv("Builds", f["builds30d"]), ...kv("Build minutes", f["buildMinutes30d"])],
          },
        ],
      });
    }
    const resetCache: ActionNode = {
      kind: "action",
      label: "Reset cache",
      variant: "danger",
      action: {
        type: "plugin-action",
        actionId: RESET_CACHE_ACTION,
        confirmMessage:
          "Reset this project's cache? Depot terminates the project's builders and deletes all cached layers. The next builds start cold and take longer.",
        successMessage: "Cache reset. The next build starts from an empty cache.",
        destructive: true,
      },
    };
    return {
      title: resource.displayName,
      subtitle: joinSubtitle("Depot project", f["regionId"]),
      status: { kind: "status-dot", status: "healthy" },
      sections,
      headerActions: [
        resetCache,
        {
          kind: "action",
          label: "Open in Depot",
          action: { type: "open-url", url: DASHBOARD_URL },
        },
        { kind: "action", label: "Refresh", action: { type: "refresh-resource" } },
      ],
      metricsCapability: DEPOT_METRICS_CAPABILITY,
      childTables: [
        {
          title: "Recent builds",
          typeId: BUILD_TYPE,
          columns: [
            { key: "id", label: "Build", source: { kind: "display-name" }, format: "mono" },
            { key: "status", label: "Status", source: { kind: "field", fieldKey: "status" } },
            { key: "created", label: "Created", source: { kind: "field", fieldKey: "createdAt" } },
            {
              key: "duration",
              label: "Duration (s)",
              width: "narrow",
              source: { kind: "field", fieldKey: "durationSeconds" },
            },
            {
              key: "hit",
              label: "Cache hit %",
              width: "narrow",
              source: { kind: "field", fieldKey: "cacheHitRate" },
            },
          ],
          emptyText: "No builds yet. Run depot build with this project to see them here.",
        },
        {
          title: "Project tokens",
          typeId: TOKEN_TYPE,
          columns: [
            { key: "description", label: "Description", source: { kind: "display-name" } },
            {
              key: "id",
              label: "Token ID",
              source: { kind: "field", fieldKey: "tokenId" },
              format: "mono",
            },
          ],
          emptyText: "No project tokens.",
          onRowClick: "navigate",
        },
        {
          title: "Trust relationships",
          typeId: TRUST_POLICY_TYPE,
          columns: [
            {
              key: "provider",
              label: "CI provider",
              source: { kind: "field", fieldKey: "provider" },
            },
            {
              key: "subject",
              label: "Trusted source",
              source: { kind: "field", fieldKey: "subject" },
              format: "mono",
            },
          ],
          emptyText: "No OIDC trust relationships.",
        },
        {
          title: "Registry images",
          typeId: IMAGE_TYPE,
          columns: [
            { key: "tag", label: "Tag", source: { kind: "display-name" }, format: "mono" },
            { key: "pushed", label: "Pushed", source: { kind: "field", fieldKey: "pushedAt" } },
            {
              key: "size",
              label: "Size (bytes)",
              source: { kind: "field", fieldKey: "sizeBytes" },
            },
          ],
          emptyText: "No images saved to this project's registry.",
        },
      ],
    };
  }

  private renderBuild(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    const status = String(f["status"] ?? "unknown");
    return {
      title: `Build ${resource.displayName}`,
      subtitle: joinSubtitle("Depot build", status),
      status: { kind: "status-dot", status: buildStatus(status), label: status },
      sections: [
        {
          kind: "section",
          title: "Build",
          children: [
            {
              kind: "key-value-list",
              items: [
                ...kv("Build ID", f["buildId"], true),
                ...kv("Status", status),
                ...kv("Created", f["createdAt"]),
                ...kv("Started", f["startedAt"]),
                ...kv("Finished", f["finishedAt"]),
                ...kv(
                  "Duration",
                  f["durationSeconds"] !== undefined
                    ? formatDuration(Number(f["durationSeconds"]))
                    : "",
                ),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "Cache",
          children: [
            {
              kind: "key-value-list",
              items: [
                ...kv(
                  "Cache hit rate",
                  f["cacheHitRate"] !== undefined ? `${String(f["cacheHitRate"])}%` : "",
                ),
                ...kv(
                  "Cached steps",
                  f["totalSteps"] !== undefined
                    ? `${String(f["cachedSteps"] ?? 0)} of ${String(f["totalSteps"])}`
                    : "",
                ),
                ...kv(
                  "Time saved",
                  f["savedSeconds"] !== undefined ? formatDuration(Number(f["savedSeconds"])) : "",
                ),
              ],
            },
          ],
        },
      ],
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  private renderActionsRepo(resource: ResourceInstance): DetailViewSchema {
    const f = resource.fields;
    let rows: DayUsage["actions"] = [];
    try {
      rows = JSON.parse(resource.resolvedOutputs[ACTIONS_STASH_KEY] ?? "[]") as DayUsage["actions"];
    } catch {
      rows = [];
    }
    const sorted = [...rows].sort((a, b) => b.billed - a.billed);
    return {
      title: resource.displayName,
      subtitle: joinSubtitle("GitHub Actions on Depot", `since ${String(f["cycleStart"] ?? "")}`),
      sections: [
        {
          kind: "section",
          title: "This billing cycle",
          children: [
            {
              kind: "key-value-list",
              items: [
                ...kv("Jobs", f["jobs"]),
                ...kv("Elapsed minutes", f["minutesElapsed"]),
                ...kv("Billed minutes", f["minutesBilled"]),
              ],
            },
          ],
        },
        {
          kind: "section",
          title: "By workflow and runner",
          children: [
            {
              kind: "table",
              columns: [
                { key: "workflow", label: "Workflow" },
                { key: "runner", label: "Runner", mono: true },
                { key: "jobs", label: "Jobs", width: "narrow" },
                { key: "elapsed", label: "Elapsed min", width: "narrow" },
                { key: "billed", label: "Billed min", width: "narrow" },
              ],
              rows: sorted.map((r) => ({
                cells: {
                  workflow: r.workflow || "-",
                  runner: r.runner || "-",
                  jobs: String(r.jobs),
                  elapsed: r.elapsed.toFixed(1),
                  billed: r.billed.toFixed(1),
                },
              })),
            },
          ],
        },
      ],
      metricsCapability: DEPOT_METRICS_CAPABILITY,
      headerActions: [{ kind: "action", label: "Refresh", action: { type: "refresh-resource" } }],
    };
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    if (resource.resourceTypeId === BUILD_TYPE) {
      const status = String(resource.fields["status"] ?? "unknown");
      return {
        id: resource.id,
        label: `${resource.displayName} · ${status}`,
        status: { kind: "status-dot", status: buildStatus(status) },
      };
    }
    if (resource.resourceTypeId === PROJECT_TYPE) {
      const region = String(resource.fields["regionId"] ?? "");
      return {
        id: resource.id,
        label: region ? `${resource.displayName} (${region})` : resource.displayName,
        status: { kind: "status-dot", status: "healthy" },
      };
    }
    return { id: resource.id, label: resource.displayName || resource.id };
  }
}
