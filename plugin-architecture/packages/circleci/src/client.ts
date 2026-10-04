import type {
  CostFetchRange,
  CostRow,
  CreateFieldConfig,
  CreateResourceConfig,
  CredentialExport,
  DashboardStat,
  DetailViewSchema,
  HostServices,
  MetricSeries,
  PluginClient,
  ResourceInstance,
  SidebarItemSchema,
} from "@infrawrench/plugin-base";
import { externalIdOf } from "@infrawrench/plugin-base";
import type { CircleContext } from "./api.js";
import {
  API_V3_BASE,
  RUNNER_API_BASE,
  circleFetch,
  circlePaged,
  circleV3,
  circleV3Paged,
  statusOf,
} from "./api.js";
import { fetchCircleCostData } from "./cost-data.js";
import type {
  CircleCollaboration,
  CircleContextItem,
  CircleJob,
  CirclePipeline,
  CircleProject,
  CircleRunner,
  CircleSchedule,
  CircleTrigger,
  CircleWorkflow,
  ContextRestriction,
  ContextVariable,
  FlakyTest,
  JobMetrics,
  OrgSummary,
  PipelineDefinition,
  ProjectVariable,
  RunnerResourceClass,
  SummaryMetrics,
  Timetable,
  WorkflowMetrics,
  WorkflowRun,
} from "./mappers.js";
import {
  mapContext,
  mapContextVariable,
  mapOrganization,
  mapPipeline,
  mapProject,
  mapProjectVariable,
  mapRunner,
  mapRunnerResourceClass,
  mapSchedule,
  mapTrigger,
  mapWorkflow,
  runnerClassOf,
  splitScoped,
} from "./mappers.js";
import {
  DEFAULT_METRICS_WINDOW_MS,
  projectSeries,
  rangeOrDefault,
  workflowSeries,
} from "./metrics.js";
import type { CircleRates } from "./rates.js";
import { parseRates } from "./rates.js";
import type { PipelineWorkflowDetail } from "./render.js";
import { DETAIL_KEYS, renderCircleDetail, renderCircleSidebar } from "./render.js";

const enc = encodeURIComponent;
const REPORTING_WINDOW = "last-30-days";
/** Pipelines listed: the most recent across the organization. */
const PIPELINE_LIMIT = 50;

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

interface ProjectRef {
  slug: string;
  name: string;
  id?: string;
}

/** The organization picker's value: the collaboration id, or its slug when it has none. */
export function findCollaboration(
  collaborations: CircleCollaboration[],
  value: string,
): CircleCollaboration | undefined {
  return collaborations.find((c) => c.id === value || c.slug === value);
}

function ints(raw: string | undefined, label: string, min: number, max: number): number[] {
  const parts = (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(
        `CircleCI plugin: "${label}" values must be whole numbers from ${min} to ${max}, got "${p}"`,
      );
    }
    return n;
  });
}

function names(raw: string | undefined, label: string, allowed: string[]): string[] {
  const parts = (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase().slice(0, 3))
    .filter(Boolean);
  for (const p of parts) {
    if (!allowed.includes(p)) {
      throw new Error(`CircleCI plugin: "${label}" accepts ${allowed.join(", ")}; got "${p}"`);
    }
  }
  return parts;
}

/** Build a schedule timetable from the comma-list fields. */
export function buildTimetable(fields: Record<string, string>): Timetable {
  const perHour = Number((fields["perHour"] ?? "").trim() || "1");
  if (!Number.isInteger(perHour) || perHour < 1 || perHour > 60) {
    throw new Error('CircleCI plugin: "Runs per Hour" must be a whole number from 1 to 60');
  }
  const hours = ints(fields["hoursOfDay"], "Hours of Day", 0, 23);
  const daysOfWeek = names(fields["daysOfWeek"], "Days of Week", DAYS);
  const daysOfMonth = ints(fields["daysOfMonth"], "Days of Month", 1, 31);
  const months = names(fields["months"], "Months", MONTHS);
  if (daysOfWeek.length > 0 && daysOfMonth.length > 0) {
    throw new Error("CircleCI plugin: choose days of the week or days of the month, not both");
  }
  return {
    "per-hour": perHour,
    "hours-of-day": hours.length > 0 ? hours : Array.from({ length: 24 }, (_, i) => i),
    ...(daysOfMonth.length > 0
      ? { "days-of-month": daysOfMonth }
      : { "days-of-week": daysOfWeek.length > 0 ? daysOfWeek : DAYS }),
    ...(months.length > 0 ? { months } : {}),
  };
}

/** Pipeline parameters from a JSON object field, plus the branch. */
export function buildParameters(
  rawJson: string | undefined,
  branch: string | undefined,
): Record<string, string | number | boolean> {
  let params: Record<string, string | number | boolean> = {};
  const raw = (rawJson ?? "").trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        'CircleCI plugin: pipeline parameters must be a JSON object, e.g. {"deploy": true}',
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        'CircleCI plugin: pipeline parameters must be a JSON object, e.g. {"deploy": true}',
      );
    }
    params = parsed as Record<string, string | number | boolean>;
  }
  const b = (branch ?? "").trim();
  return b ? { ...params, branch: b } : params;
}

export class CircleCIClient implements PluginClient {
  private readonly ctx: CircleContext;
  private readonly orgValue: string;
  private readonly rates: CircleRates;
  private orgCache: Promise<CircleCollaboration> | undefined;
  private projectsCache: Promise<ProjectRef[]> | undefined;
  private pipelinesCache: Promise<CirclePipeline[]> | undefined;

  constructor(credentials: Record<string, string>, services?: HostServices) {
    const token = (credentials["apiToken"] ?? "").trim();
    if (!token) throw new Error("CircleCI plugin: missing apiToken credential");
    this.ctx = { token, ...(services?.http ? { http: services.http } : {}) };
    this.orgValue = (credentials["organization"] ?? "").trim();
    if (!this.orgValue) throw new Error("CircleCI plugin: pick an organization");
    this.rates = parseRates(credentials);
  }

  // -------------------------------------------------------------------------
  // Shared lookups
  // -------------------------------------------------------------------------

  private org(): Promise<CircleCollaboration> {
    this.orgCache ??= circleFetch<CircleCollaboration[]>(this.ctx, "/me/collaborations")
      .then((list) => {
        const found = findCollaboration(list ?? [], this.orgValue);
        if (!found) {
          throw new Error(
            `CircleCI plugin: the token's user is not a member of organization "${this.orgValue}". Pick an organization again under Edit credentials.`,
          );
        }
        return found;
      })
      .catch((err: unknown) => {
        this.orgCache = undefined;
        throw err;
      });
    return this.orgCache;
  }

  private async orgSummary(projectNames?: string[]): Promise<OrgSummary | undefined> {
    const org = await this.org();
    return circleFetch<OrgSummary>(this.ctx, `/insights/${org.slug}/summary`, {
      query: {
        "reporting-window": REPORTING_WINDOW,
        ...(projectNames ? { "project-names": projectNames } : {}),
      },
    }).catch(() => undefined);
  }

  private recentPipelines(): Promise<CirclePipeline[]> {
    this.pipelinesCache ??= this.org()
      .then((org) =>
        circlePaged<CirclePipeline>(this.ctx, "/pipeline", { "org-slug": org.slug }, 3),
      )
      .catch((err: unknown) => {
        this.pipelinesCache = undefined;
        throw err;
      });
    return this.pipelinesCache;
  }

  /**
   * The organization's projects. API v3 lists them (id and name); v2 needs a
   * slug, which for GitHub OAuth and Bitbucket organizations is the org slug
   * plus the name, and for GitHub App and standalone organizations
   * (`circleci/…`) is opaque, so it is taken from recent pipelines and
   * matched by name. Without v3 the Insights summary's project names stand in.
   */
  private projects(): Promise<ProjectRef[]> {
    this.projectsCache ??= this.loadProjects().catch((err: unknown) => {
      this.projectsCache = undefined;
      throw err;
    });
    return this.projectsCache;
  }

  private async loadProjects(): Promise<ProjectRef[]> {
    const org = await this.org();
    const vcsSlugs = !org.slug.startsWith("circleci/");
    const [listed, pipelines] = await Promise.all([
      org.id
        ? circleV3Paged<{ id: string; attributes?: { name?: string } }>(this.ctx, "/projects", {
            "filter[org_id]": org.id,
            "page[limit]": 50,
          }).catch(() => undefined)
        : Promise.resolve(undefined),
      this.recentPipelines().catch(() => [] as CirclePipeline[]),
    ]);
    const bySlug = new Map<string, ProjectRef>();
    // Slugs seen on pipelines; their names need a lookup for opaque slugs.
    const pipelineSlugs = [...new Set(pipelines.map((p) => p.project_slug))];
    const named = new Map<string, ProjectRef>();
    for (const slug of pipelineSlugs) {
      if (vcsSlugs) {
        named.set(slug.split("/").slice(2).join("/"), {
          slug,
          name: slug.split("/").slice(2).join("/"),
        });
      } else {
        const p = await circleFetch<CircleProject>(this.ctx, `/project/${slug}`).catch(
          () => undefined,
        );
        if (p) named.set(p.name, { slug: p.slug, name: p.name, id: p.id });
      }
    }
    let names: Array<{ name: string; id?: string }>;
    if (listed) {
      names = listed.map((p) => ({ name: p.attributes?.name ?? p.id, id: p.id }));
    } else {
      const summary = await this.orgSummary();
      names = (summary?.all_projects ?? []).map((name) => ({ name }));
    }
    for (const { name, id } of names) {
      const known = named.get(name);
      const slug =
        known?.slug ?? (vcsSlugs ? `${org.slug}/${name}` : id ? `${org.slug}/${id}` : "");
      if (!slug) continue;
      const pid = id ?? known?.id;
      bySlug.set(slug, { slug, name, ...(pid ? { id: pid } : {}) });
    }
    for (const ref of named.values()) if (!bySlug.has(ref.slug)) bySlug.set(ref.slug, ref);
    return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async projectId(slug: string): Promise<string> {
    const known = (await this.projects().catch(() => [] as ProjectRef[])).find(
      (p) => p.slug === slug,
    );
    if (known?.id) return known.id;
    return (await circleFetch<CircleProject>(this.ctx, `/project/${slug}`)).id;
  }

  private async contexts(): Promise<CircleContextItem[]> {
    const org = await this.org();
    return circlePaged<CircleContextItem>(this.ctx, "/context", {
      ...(org.id ? { "owner-id": org.id } : { "owner-slug": org.slug }),
      "owner-type": "organization",
    });
  }

  private contextVariables(contextId: string): Promise<ContextVariable[]> {
    return circlePaged<ContextVariable>(
      this.ctx,
      `/context/${enc(contextId)}/environment-variable`,
    );
  }

  private async runnerClasses(): Promise<RunnerResourceClass[]> {
    const org = await this.org();
    return circleV3Paged<RunnerResourceClass>(this.ctx, "/runner/resource-classes", {
      "filter[org_id]": org.id,
    });
  }

  private async runnerAgents(): Promise<CircleRunner[]> {
    const org = await this.org();
    return circleV3Paged<CircleRunner>(this.ctx, "/runner/agents", {
      "filter[org_id]": org.id,
      "page[limit]": 250,
    });
  }

  /** Waiting and running task counts for a runner resource class (runner API). */
  private async runnerTasks(
    resourceClass: string,
  ): Promise<{ unclaimed?: number; running?: number }> {
    const [waiting, running] = await Promise.all([
      circleFetch<{ unclaimed_task_count?: number }>(this.ctx, "/runner/tasks", {
        baseUrl: RUNNER_API_BASE,
        query: { "resource-class": resourceClass },
      }).catch(() => undefined),
      circleFetch<{ running_runner_tasks?: number }>(this.ctx, "/runner/tasks/running", {
        baseUrl: RUNNER_API_BASE,
        query: { "resource-class": resourceClass },
      }).catch(() => undefined),
    ]);
    return {
      ...(waiting?.unclaimed_task_count !== undefined
        ? { unclaimed: waiting.unclaimed_task_count }
        : {}),
      ...(running?.running_runner_tasks !== undefined
        ? { running: running.running_runner_tasks }
        : {}),
    };
  }

  private workflowMetrics(slug: string): Promise<WorkflowMetrics[]> {
    return circlePaged<WorkflowMetrics>(
      this.ctx,
      `/insights/${slug}/workflows`,
      {
        "all-branches": true,
        "reporting-window": REPORTING_WINDOW,
      },
      3,
    );
  }

  /** Every project-scoped list, one project at a time, skipping projects that refuse. */
  private async perProject(
    fn: (p: ProjectRef) => Promise<ResourceInstance[]>,
  ): Promise<ResourceInstance[]> {
    const out: ResourceInstance[] = [];
    for (const p of await this.projects()) {
      try {
        out.push(...(await fn(p)));
      } catch (err) {
        const status = statusOf(err);
        if (status !== 400 && status !== 403 && status !== 404) throw err;
      }
    }
    return out;
  }

  private async pipelineDefinitions(projectId: string): Promise<PipelineDefinition[]> {
    const res = await circleFetch<{ items?: PipelineDefinition[] }>(
      this.ctx,
      `/projects/${enc(projectId)}/pipeline-definitions`,
    );
    return res?.items ?? [];
  }

  private async triggersFor(
    accountId: string,
    p: ProjectRef & { id: string },
  ): Promise<ResourceInstance[]> {
    const out: ResourceInstance[] = [];
    for (const def of await this.pipelineDefinitions(p.id)) {
      const res = await circleFetch<{ items?: CircleTrigger[] }>(
        this.ctx,
        `/projects/${enc(p.id)}/pipeline-definitions/${enc(def.id)}/triggers`,
      );
      out.push(...(res?.items ?? []).map((t) => mapTrigger(accountId, p.slug, p.id, def, t)));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  async listResources(typeId: string, accountId: string): Promise<ResourceInstance[]> {
    const price = this.rates.pricePerCredit;
    switch (typeId) {
      case "organization": {
        const [org, summary] = await Promise.all([this.org(), this.orgSummary()]);
        return [mapOrganization(accountId, org, summary, price)];
      }
      case "project": {
        this.projectsCache = undefined;
        const [projects, summary] = await Promise.all([this.projects(), this.orgSummary()]);
        const metrics = new Map(
          (summary?.org_project_data ?? []).map((p) => [p.project_name, p.metrics]),
        );
        return projects.map((p) =>
          mapProject(
            accountId,
            { slug: p.slug, name: p.name, ...(p.id ? { id: p.id } : {}) },
            metrics.get(p.name),
            price,
          ),
        );
      }
      case "workflow":
        return this.perProject(async (p) =>
          (await this.workflowMetrics(p.slug)).map((w) => mapWorkflow(accountId, p.slug, w)),
        );
      case "pipeline": {
        this.pipelinesCache = undefined;
        return (await this.recentPipelines())
          .slice(0, PIPELINE_LIMIT)
          .map((p) => mapPipeline(accountId, p));
      }
      case "context": {
        const contexts = await this.contexts();
        const out: ResourceInstance[] = [];
        for (const c of contexts) {
          const vars = await this.contextVariables(c.id).catch(() => undefined);
          out.push(mapContext(accountId, c, vars));
        }
        return out;
      }
      case "context-variable": {
        const out: ResourceInstance[] = [];
        for (const c of await this.contexts()) {
          const vars = await this.contextVariables(c.id).catch(() => [] as ContextVariable[]);
          out.push(...vars.map((v) => mapContextVariable(accountId, c, v)));
        }
        return out;
      }
      case "project-variable":
        return this.perProject(async (p) =>
          (await circlePaged<ProjectVariable>(this.ctx, `/project/${p.slug}/envvar`)).map((v) =>
            mapProjectVariable(accountId, p.slug, v),
          ),
        );
      case "schedule":
        return this.perProject(async (p) =>
          (await circlePaged<CircleSchedule>(this.ctx, `/project/${p.slug}/schedule`)).map((s) =>
            mapSchedule(accountId, { ...s, "project-slug": s["project-slug"] ?? p.slug }),
          ),
        );
      case "trigger":
        return this.perProject(async (p) => {
          const id = p.id ?? (await this.projectId(p.slug));
          return this.triggersFor(accountId, { ...p, id });
        });
      case "runner-resource-class": {
        let classes: RunnerResourceClass[];
        try {
          classes = await this.runnerClasses();
        } catch (err) {
          // No runner namespace, or a plan without runners: nothing to list.
          if (statusOf(err) === 403 || statusOf(err) === 404) return [];
          throw err;
        }
        const agents = await this.runnerAgents().catch(() => undefined);
        const out: ResourceInstance[] = [];
        for (const rc of classes) {
          const name = rc.attributes?.resource_class ?? "";
          const count = agents?.filter((a) => runnerClassOf(a).id === rc.id).length;
          out.push(
            mapRunnerResourceClass(accountId, rc, count, name ? await this.runnerTasks(name) : {}),
          );
        }
        return out;
      }
      case "runner":
        try {
          return (await this.runnerAgents()).map((r) => mapRunner(accountId, r));
        } catch (err) {
          if (statusOf(err) === 403 || statusOf(err) === 404) return [];
          throw err;
        }
      default:
        throw new Error(`CircleCI plugin: unknown resource type "${typeId}"`);
    }
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
    const price = this.rates.pricePerCredit;
    switch (typeId) {
      case "organization": {
        const [org, summary] = await Promise.all([this.org(), this.orgSummary()]);
        const r = mapOrganization(accountId, org, summary, price);
        return summary ? stash(r, { [DETAIL_KEYS.orgSummary]: summary }) : r;
      }
      case "project": {
        const p = await circleFetch<CircleProject>(this.ctx, `/project/${id}`);
        const [summary, workflows, flaky] = await Promise.all([
          this.orgSummary([p.name]),
          this.workflowMetrics(p.slug).catch(() => undefined),
          circleFetch<{ "flaky-tests"?: FlakyTest[] }>(
            this.ctx,
            `/insights/${p.slug}/flaky-tests`,
          ).catch(() => undefined),
        ]);
        const metrics: SummaryMetrics | undefined = summary?.org_project_data?.find(
          (x) => x.project_name === p.name,
        )?.metrics;
        return stash(mapProject(accountId, p, metrics, price), {
          ...(workflows ? { [DETAIL_KEYS.workflows]: workflows } : {}),
          ...(flaky ? { [DETAIL_KEYS.flakyTests]: flaky["flaky-tests"] ?? [] } : {}),
        });
      }
      case "workflow": {
        const { projectSlug, rest: name } = splitScoped(id);
        const [workflows, jobs, runs] = await Promise.all([
          this.workflowMetrics(projectSlug),
          circlePaged<JobMetrics>(
            this.ctx,
            `/insights/${projectSlug}/workflows/${enc(name)}/jobs`,
            {
              "all-branches": true,
              "reporting-window": REPORTING_WINDOW,
            },
            3,
          ).catch(() => undefined),
          circleFetch<{ items?: WorkflowRun[] }>(
            this.ctx,
            `/insights/${projectSlug}/workflows/${enc(name)}`,
            {
              query: { "all-branches": true },
            },
          ).catch(() => undefined),
        ]);
        const w = workflows.find((x) => x.name === name);
        if (!w)
          throw new Error(`CircleCI plugin: workflow "${name}" has no runs in the last 30 days`);
        return stash(mapWorkflow(accountId, projectSlug, w), {
          ...(jobs ? { [DETAIL_KEYS.jobs]: jobs } : {}),
          ...(runs?.items ? { [DETAIL_KEYS.runs]: runs.items.slice(0, 20) } : {}),
        });
      }
      case "pipeline": {
        const p = await circleFetch<CirclePipeline>(this.ctx, `/pipeline/${enc(id)}`);
        const workflows = await circlePaged<CircleWorkflow>(
          this.ctx,
          `/pipeline/${enc(id)}/workflow`,
        );
        const detailed: PipelineWorkflowDetail[] = [];
        for (const w of workflows) {
          const jobs = await circlePaged<CircleJob>(this.ctx, `/workflow/${enc(w.id)}/job`).catch(
            () => undefined,
          );
          detailed.push({ ...w, ...(jobs ? { jobs } : {}) });
        }
        return stash(mapPipeline(accountId, p), { [DETAIL_KEYS.pipelineWorkflows]: detailed });
      }
      case "context": {
        const c = await circleFetch<CircleContextItem>(this.ctx, `/context/${enc(id)}`);
        const [vars, restrictions] = await Promise.all([
          this.contextVariables(id).catch(() => undefined),
          circlePaged<ContextRestriction>(this.ctx, `/context/${enc(id)}/restrictions`).catch(
            () => undefined,
          ),
        ]);
        const r = mapContext(accountId, c, vars, restrictions);
        return restrictions ? stash(r, { [DETAIL_KEYS.restrictions]: restrictions }) : r;
      }
      case "context-variable": {
        const [contextId, ...nameParts] = id.split("/");
        const name = nameParts.join("/");
        const c = await circleFetch<CircleContextItem>(
          this.ctx,
          `/context/${enc(contextId ?? "")}`,
        );
        const v = (await this.contextVariables(c.id)).find((x) => x.variable === name);
        if (!v) throw new Error(`CircleCI plugin: context variable "${name}" not found`);
        return mapContextVariable(accountId, c, v);
      }
      case "project-variable": {
        const { projectSlug, rest: name } = splitScoped(id);
        const v = await circleFetch<ProjectVariable>(
          this.ctx,
          `/project/${projectSlug}/envvar/${enc(name)}`,
        );
        return mapProjectVariable(accountId, projectSlug, v);
      }
      case "schedule":
        return mapSchedule(
          accountId,
          await circleFetch<CircleSchedule>(this.ctx, `/schedule/${enc(id)}`),
        );
      case "trigger": {
        const { projectSlug, rest } = splitScoped(id);
        const [projectId, triggerId] = rest.split("/");
        const t = await circleFetch<CircleTrigger>(
          this.ctx,
          `/projects/${enc(projectId ?? "")}/triggers/${enc(triggerId ?? "")}`,
        );
        return mapTrigger(accountId, projectSlug, projectId ?? "", {} as PipelineDefinition, t);
      }
      case "runner-resource-class": {
        const rc = await circleV3<RunnerResourceClass>(
          this.ctx,
          `/runner/resource-classes/${enc(id)}`,
        );
        if (!rc) throw new Error(`CircleCI plugin: runner resource class "${id}" not found`);
        const name = rc.attributes?.resource_class ?? "";
        const agents = await circleV3Paged<CircleRunner>(this.ctx, "/runner/agents", {
          "filter[resource_class]": name,
          "page[limit]": 250,
        }).catch(() => undefined);
        return mapRunnerResourceClass(
          accountId,
          rc,
          agents?.length,
          name ? await this.runnerTasks(name) : {},
        );
      }
      case "runner": {
        const agent = (await this.runnerAgents()).find((a) => a.id === id);
        if (!agent) throw new Error(`CircleCI plugin: runner "${id}" not found`);
        return mapRunner(accountId, agent);
      }
      default:
        throw new Error(`CircleCI plugin: unknown resource type "${typeId}"`);
    }
  }

  async resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): Promise<string> {
    const resource = await this.getResource(typeId, resourceId, accountId);
    const resolved = resource.resolvedOutputs[outputKey];
    if (resolved !== undefined) return resolved;
    const field = resource.fields[outputKey];
    if (field !== undefined) return String(field);
    throw new Error(`CircleCI plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs
  // -------------------------------------------------------------------------

  async fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): Promise<DashboardStat[]> {
    const r = await this.getResource(resourceTypeId, resourceId, accountId);
    const f = r.fields;
    const n = (v: unknown, suffix = "") =>
      typeof v === "number"
        ? `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}${suffix}`
        : "—";
    const rateVariant = (v: unknown): NonNullable<DashboardStat["variant"]> =>
      typeof v !== "number"
        ? "default"
        : v >= 90
          ? "status-healthy"
          : v >= 70
            ? "status-degraded"
            : "status-error";
    switch (resourceTypeId) {
      case "organization":
      case "project":
        return [
          { label: "Credits (30d)", value: n(f["credits30d"]) },
          {
            label: "Est. cost (30d)",
            value: typeof f["estimatedCost30d"] === "number" ? `$${n(f["estimatedCost30d"])}` : "—",
          },
          {
            label: "Success rate",
            value: n(f["successRate30d"], "%"),
            variant: rateVariant(f["successRate30d"]),
          },
        ];
      case "workflow":
        return [
          {
            label: "Success rate",
            value: n(f["successRate"], "%"),
            variant: rateVariant(f["successRate"]),
          },
          { label: "p95", value: n(f["durationP95Secs"], " s") },
          { label: "Credits (30d)", value: n(f["credits"]) },
        ];
      case "runner-resource-class": {
        const waiting = f["unclaimedTasks"];
        return [
          { label: "Runners", value: n(f["runnerCount"]) },
          {
            label: "Waiting",
            value: n(waiting),
            variant: typeof waiting === "number" && waiting > 0 ? "status-degraded" : "default",
          },
        ];
      }
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
    const id = externalIdOf(resourceId);
    const range = rangeOrDefault(timeRange, DEFAULT_METRICS_WINDOW_MS);
    switch (resourceTypeId) {
      case "project":
        return projectSeries(this.ctx, id, range);
      case "workflow": {
        const { projectSlug, rest } = splitScoped(id);
        return workflowSeries(this.ctx, projectSlug, rest, range);
      }
      default:
        return [];
    }
  }

  async fetchCostData(_accountId: string, range: CostFetchRange): Promise<CostRow[]> {
    const org = await this.org();
    return fetchCircleCostData(this.ctx, org.id, this.rates, range);
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  private async projectField(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const projects = await this.projects().catch(() => [] as ProjectRef[]);
    return [
      {
        key: "project",
        label: "Project",
        kind: "select",
        required: true,
        ...(projects[0] ? { defaultValue: projects[0].slug } : {}),
        options: projects.map((p) => ({ id: p.slug, label: p.name, description: p.slug })),
      },
    ];
  }

  async getCreateConfig(typeId: string, parentResourceId?: string): Promise<CreateResourceConfig> {
    const parent = parentResourceId ? externalIdOf(parentResourceId) : undefined;
    switch (typeId) {
      case "pipeline": {
        const defs = parent
          ? await this.projectId(parent)
              .then((pid) => this.pipelineDefinitions(pid))
              .catch(() => [] as PipelineDefinition[])
          : [];
        return {
          fields: [
            ...(await this.projectField(parentResourceId)),
            ...(defs.length > 1
              ? [
                  {
                    key: "definition",
                    label: "Pipeline definition",
                    kind: "select" as const,
                    required: false,
                    defaultValue: defs[0]!.id,
                    options: defs.map((d) => ({
                      id: d.id,
                      label: d.name ?? d.id,
                      ...(d.config_source?.file_path
                        ? { description: d.config_source.file_path }
                        : {}),
                    })),
                  },
                ]
              : []),
            {
              key: "branch",
              label: "Branch",
              kind: "text",
              required: false,
              placeholder: "main",
              description:
                "The branch to build. Leave empty for the project's default branch, or enter a tag instead.",
            },
            { key: "tag", label: "Tag", kind: "text", required: false, placeholder: "v1.2.3" },
            {
              key: "parameters",
              label: "Pipeline parameters (JSON)",
              kind: "text",
              multiline: true,
              required: false,
              placeholder: '{"deploy": true}',
              description: "Values for the parameters your config declares.",
            },
          ],
        };
      }
      case "context":
        return {
          fields: [
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "aws-production",
            },
          ],
        };
      case "context-variable": {
        const contexts = parent ? [] : await this.contexts().catch(() => [] as CircleContextItem[]);
        return {
          fields: [
            ...(parent
              ? []
              : [
                  {
                    key: "context",
                    label: "Context",
                    kind: "select" as const,
                    required: true,
                    ...(contexts[0] ? { defaultValue: contexts[0].id } : {}),
                    options: contexts.map((c) => ({ id: c.id, label: c.name })),
                  },
                ]),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "AWS_ACCESS_KEY_ID",
            },
            { key: "value", label: "Value", kind: "password", required: true },
          ],
        };
      }
      case "project-variable":
        return {
          fields: [
            ...(await this.projectField(parentResourceId)),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "NPM_TOKEN" },
            { key: "value", label: "Value", kind: "password", required: true },
          ],
        };
      case "schedule":
        return {
          fields: [
            ...(await this.projectField(parentResourceId)),
            { key: "name", label: "Name", kind: "text", required: true, placeholder: "nightly" },
            { key: "description", label: "Description", kind: "text", required: false },
            {
              key: "perHour",
              label: "Runs per hour",
              kind: "number",
              required: true,
              defaultValue: "1",
              minValue: 1,
              maxValue: 60,
            },
            {
              key: "hoursOfDay",
              label: "Hours of day (UTC)",
              kind: "text",
              required: false,
              placeholder: "2",
              description: "Comma-separated hours from 0 to 23. Leave empty for every hour.",
            },
            {
              key: "daysOfWeek",
              label: "Days of week",
              kind: "text",
              required: false,
              placeholder: "MON,TUE,WED,THU,FRI",
              description:
                "Comma-separated. Leave empty for every day, or use days of month instead.",
            },
            {
              key: "daysOfMonth",
              label: "Days of month",
              kind: "text",
              required: false,
              placeholder: "1,15",
            },
            {
              key: "months",
              label: "Months",
              kind: "text",
              required: false,
              placeholder: "JAN,APR,JUL,OCT",
              description: "Leave empty for every month.",
            },
            { key: "branch", label: "Branch", kind: "text", required: true, placeholder: "main" },
            {
              key: "parameters",
              label: "Pipeline parameters (JSON)",
              kind: "text",
              multiline: true,
              required: false,
              placeholder: '{"nightly": true}',
            },
            {
              key: "actor",
              label: "Run as",
              kind: "select",
              required: true,
              defaultValue: "current",
              options: [
                {
                  id: "current",
                  label: "You",
                  description: "Pipelines are attributed to your user.",
                },
                {
                  id: "system",
                  label: "Scheduling system",
                  description: "Pipelines are attributed to CircleCI's scheduler.",
                },
              ],
            },
          ],
        };
      case "trigger": {
        const defs = parent
          ? await this.projectId(parent)
              .then((pid) => this.pipelineDefinitions(pid))
              .catch(() => [] as PipelineDefinition[])
          : [];
        return {
          fields: [
            ...(await this.projectField(parentResourceId)),
            ...(defs.length > 0
              ? [
                  {
                    key: "definition",
                    label: "Pipeline definition",
                    kind: "select" as const,
                    required: true,
                    defaultValue: defs[0]!.id,
                    options: defs.map((d) => ({ id: d.id, label: d.name ?? d.id })),
                  },
                ]
              : []),
            {
              key: "name",
              label: "Name",
              kind: "text",
              required: true,
              placeholder: "Nightly build",
            },
            {
              key: "cronExpression",
              label: "Cron schedule (UTC)",
              kind: "text",
              required: true,
              placeholder: "0 3 * * 1-5",
              description: "Five fields: minute, hour, day of month, month, day of week.",
            },
            {
              key: "checkoutRef",
              label: "Checkout ref",
              kind: "text",
              required: true,
              placeholder: "main",
            },
            {
              key: "configRef",
              label: "Config ref",
              kind: "text",
              required: false,
              placeholder: "main",
              description: "Where to read the config from. Defaults to the checkout ref.",
            },
            {
              key: "actor",
              label: "Run as",
              kind: "select",
              required: true,
              defaultValue: "current",
              options: [
                { id: "current", label: "You" },
                { id: "system", label: "Scheduling system" },
              ],
            },
          ],
        };
      }
      case "runner-resource-class": {
        const classes = await this.runnerClasses().catch(() => [] as RunnerResourceClass[]);
        const namespace = classes[0]?.attributes?.resource_class?.split("/")[0];
        return {
          fields: [
            {
              key: "resourceClass",
              label: "Resource class",
              kind: "text",
              required: true,
              placeholder: namespace ? `${namespace}/linux-large` : "my-namespace/linux-large",
              description:
                "namespace/name. The namespace is your organization's (the same as its orb namespace) and must exist before the first resource class.",
            },
            {
              key: "description",
              label: "Description",
              kind: "text",
              required: true,
              placeholder: "Linux runners in the build VPC",
            },
          ],
        };
      }
      default:
        throw new Error(`CircleCI plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): Promise<ResourceInstance> {
    const parent = parentResourceId ? externalIdOf(parentResourceId) : undefined;
    const project = (fields["project"] ?? "").trim() || parent || "";
    const need = (key: string, label: string) => {
      const v = (fields[key] ?? "").trim();
      if (!v) throw new Error(`CircleCI plugin: "${label}" is required`);
      return v;
    };
    switch (typeId) {
      case "pipeline": {
        if (!project) throw new Error('CircleCI plugin: "Project" is required');
        const branch = (fields["branch"] ?? "").trim();
        const tag = (fields["tag"] ?? "").trim();
        if (branch && tag) throw new Error("CircleCI plugin: enter a branch or a tag, not both");
        const params = buildParameters(fields["parameters"], undefined);
        const ref = branch ? { branch } : tag ? { tag } : undefined;
        const [provider, orgName, ...rest] = project.split("/");
        let created: { id?: string; message?: string } | undefined;
        try {
          created = await circleFetch(
            this.ctx,
            `/project/${provider}/${orgName}/${rest.join("/")}/pipeline/run`,
            {
              method: "POST",
              body: {
                ...(fields["definition"] ? { definition_id: fields["definition"] } : {}),
                ...(ref ? { config: ref, checkout: ref } : {}),
                ...(Object.keys(params).length > 0 ? { parameters: params } : {}),
              },
            },
          );
        } catch (err) {
          // Organizations the newer endpoint does not cover still take the
          // original trigger.
          const status = statusOf(err);
          if (status !== 400 && status !== 404) throw err;
          created = await circleFetch(this.ctx, `/project/${project}/pipeline`, {
            method: "POST",
            body: {
              ...(ref ?? {}),
              ...(Object.keys(params).length > 0 ? { parameters: params } : {}),
            },
          });
        }
        if (!created?.id) {
          throw new Error(
            `CircleCI did not start a pipeline${created?.message ? `: ${created.message}` : ""}`,
          );
        }
        return this.getResource("pipeline", `${accountId}:pipeline:${created.id}`, accountId);
      }
      case "context": {
        const org = await this.org();
        const c = await circleFetch<CircleContextItem>(this.ctx, "/context", {
          method: "POST",
          body: {
            name: need("name", "Name"),
            owner: org.id
              ? { id: org.id, type: "organization" }
              : { slug: org.slug, type: "organization" },
          },
        });
        return mapContext(accountId, c, []);
      }
      case "context-variable": {
        const contextId = (fields["context"] ?? "").trim() || parent || "";
        if (!contextId) throw new Error('CircleCI plugin: "Context" is required');
        const name = need("name", "Name");
        await circleFetch(
          this.ctx,
          `/context/${enc(contextId)}/environment-variable/${enc(name)}`,
          {
            method: "PUT",
            body: { value: fields["value"] ?? "" },
          },
        );
        return this.getResource(
          "context-variable",
          `${accountId}:context-variable:${contextId}/${name}`,
          accountId,
        );
      }
      case "project-variable": {
        if (!project) throw new Error('CircleCI plugin: "Project" is required');
        const v = await circleFetch<ProjectVariable>(this.ctx, `/project/${project}/envvar`, {
          method: "POST",
          body: { name: need("name", "Name"), value: fields["value"] ?? "" },
        });
        return mapProjectVariable(accountId, project, v);
      }
      case "schedule": {
        if (!project) throw new Error('CircleCI plugin: "Project" is required');
        const description = (fields["description"] ?? "").trim();
        const s = await circleFetch<CircleSchedule>(this.ctx, `/project/${project}/schedule`, {
          method: "POST",
          body: {
            name: need("name", "Name"),
            ...(description ? { description } : {}),
            timetable: buildTimetable(fields),
            "attribution-actor": fields["actor"] === "system" ? "system" : "current",
            parameters: buildParameters(fields["parameters"], need("branch", "Branch")),
          },
        });
        return mapSchedule(accountId, { ...s, "project-slug": s["project-slug"] ?? project });
      }
      case "trigger": {
        if (!project) throw new Error('CircleCI plugin: "Project" is required');
        const projectId = await this.projectId(project);
        const defs = await this.pipelineDefinitions(projectId);
        const def = defs.find((d) => d.id === fields["definition"]) ?? defs[0];
        if (!def) {
          throw new Error(
            "CircleCI plugin: this project has no pipeline definition to attach a trigger to. GitHub OAuth and Bitbucket projects use Schedules instead.",
          );
        }
        const checkout = need("checkoutRef", "Checkout ref");
        const t = await circleFetch<CircleTrigger>(
          this.ctx,
          `/projects/${enc(projectId)}/pipeline-definitions/${enc(def.id)}/triggers`,
          {
            method: "POST",
            body: {
              event_name: need("name", "Name"),
              event_source: {
                provider: "schedule",
                schedule: {
                  cron_expression: need("cronExpression", "Cron schedule"),
                  attribution_actor: fields["actor"] === "system" ? "system" : "current",
                },
              },
              checkout_ref: checkout,
              config_ref: (fields["configRef"] ?? "").trim() || checkout,
            },
          },
        );
        return mapTrigger(accountId, project, projectId, def, t);
      }
      case "runner-resource-class": {
        const org = await this.org();
        const name = need("resourceClass", "Resource class");
        if (!/^[^/\s]+\/[^/\s]+$/.test(name)) {
          throw new Error('CircleCI plugin: the resource class must be "namespace/name"');
        }
        const rc = await circleV3<RunnerResourceClass>(this.ctx, "/runner/resource-classes", {
          method: "POST",
          body: {
            data: {
              attributes: { resource_class: name, description: need("description", "Description") },
              references: { org: { id: org.id } },
            },
          },
        });
        if (!rc) throw new Error("CircleCI did not return the new resource class");
        return mapRunnerResourceClass(accountId, rc, 0, {});
      }
      default:
        throw new Error(`CircleCI plugin: cannot create "${typeId}" from Infrawrench`);
    }
  }

  async updateResource(
    typeId: string,
    resourceId: string,
    accountId: string,
    fields: Record<string, string>,
  ): Promise<ResourceInstance> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "context-variable": {
        const value = fields["value"] ?? "";
        if (value) {
          const [contextId, ...nameParts] = id.split("/");
          await circleFetch(
            this.ctx,
            `/context/${enc(contextId ?? "")}/environment-variable/${enc(nameParts.join("/"))}`,
            {
              method: "PUT",
              body: { value },
            },
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "project-variable": {
        const value = fields["value"] ?? "";
        const { projectSlug, rest: name } = splitScoped(id);
        if (value) {
          await circleFetch(this.ctx, `/project/${projectSlug}/envvar`, {
            method: "POST",
            body: { name, value },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "schedule": {
        const current = await this.getResource(typeId, resourceId, accountId);
        const merged: Record<string, string> = {};
        for (const [k, v] of Object.entries(current.fields)) merged[k] = String(v);
        Object.assign(merged, fields);
        const body: Record<string, unknown> = {};
        if ("name" in fields) body["name"] = (fields["name"] ?? "").trim();
        if ("description" in fields) body["description"] = (fields["description"] ?? "").trim();
        if (
          ["perHour", "hoursOfDay", "daysOfWeek", "daysOfMonth", "months"].some((k) => k in fields)
        ) {
          body["timetable"] = buildTimetable(merged);
        }
        if ("branch" in fields || "parameters" in fields) {
          body["parameters"] = buildParameters(merged["parameters"], merged["branch"]);
        }
        if (Object.keys(body).length > 0) {
          await circleFetch(this.ctx, `/schedule/${enc(id)}`, { method: "PATCH", body });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "trigger": {
        const { rest } = splitScoped(id);
        const [projectId, triggerId] = rest.split("/");
        const body: Record<string, unknown> = {};
        if ("checkoutRef" in fields) body["checkout_ref"] = (fields["checkoutRef"] ?? "").trim();
        if ("configRef" in fields) body["config_ref"] = (fields["configRef"] ?? "").trim();
        if ("cronExpression" in fields) {
          body["event_source"] = {
            schedule: { cron_expression: (fields["cronExpression"] ?? "").trim() },
          };
        }
        if (Object.keys(body).length > 0) {
          await circleFetch(
            this.ctx,
            `/projects/${enc(projectId ?? "")}/triggers/${enc(triggerId ?? "")}`,
            {
              method: "PATCH",
              body,
            },
          );
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      case "runner-resource-class": {
        if ("description" in fields) {
          await circleFetch(this.ctx, `/runner/resource-classes/${enc(id)}/update`, {
            baseUrl: API_V3_BASE,
            method: "POST",
            body: { description: (fields["description"] ?? "").trim() },
          });
        }
        return this.getResource(typeId, resourceId, accountId);
      }
      default:
        throw new Error(`CircleCI plugin: cannot edit "${typeId}" from Infrawrench`);
    }
  }

  async deleteResource(typeId: string, resourceId: string, _accountId: string): Promise<void> {
    const id = externalIdOf(resourceId);
    switch (typeId) {
      case "context":
        await circleFetch(this.ctx, `/context/${enc(id)}`, { method: "DELETE" });
        return;
      case "context-variable": {
        const [contextId, ...nameParts] = id.split("/");
        await circleFetch(
          this.ctx,
          `/context/${enc(contextId ?? "")}/environment-variable/${enc(nameParts.join("/"))}`,
          {
            method: "DELETE",
          },
        );
        return;
      }
      case "project-variable": {
        const { projectSlug, rest } = splitScoped(id);
        await circleFetch(this.ctx, `/project/${projectSlug}/envvar/${enc(rest)}`, {
          method: "DELETE",
        });
        return;
      }
      case "schedule":
        await circleFetch(this.ctx, `/schedule/${enc(id)}`, { method: "DELETE" });
        return;
      case "trigger": {
        const { rest } = splitScoped(id);
        const [projectId, triggerId] = rest.split("/");
        await circleFetch(
          this.ctx,
          `/projects/${enc(projectId ?? "")}/triggers/${enc(triggerId ?? "")}`,
          {
            method: "DELETE",
          },
        );
        return;
      }
      case "runner-resource-class":
        // `force` also revokes the class's runner tokens; without it a class
        // that still has tokens cannot be deleted at all.
        await circleFetch(this.ctx, `/runner/resource-classes/${enc(id)}`, {
          baseUrl: API_V3_BASE,
          method: "DELETE",
          query: { force: true },
        });
        return;
      default:
        throw new Error(`CircleCI plugin: cannot delete "${typeId}" from Infrawrench`);
    }
  }

  // -------------------------------------------------------------------------
  // Actions and credentials
  // -------------------------------------------------------------------------

  async invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): Promise<void> {
    const id = externalIdOf(resourceId);
    if (typeId === "pipeline" || typeId === "workflow") {
      const [verb, workflowId, approvalId] = actionId.split(":");
      if (workflowId) {
        switch (verb) {
          case "rerun":
            await circleFetch(this.ctx, `/workflow/${enc(workflowId)}/rerun`, {
              method: "POST",
              body: {},
            });
            return;
          case "rerun-failed":
            await circleFetch(this.ctx, `/workflow/${enc(workflowId)}/rerun`, {
              method: "POST",
              body: { from_failed: true },
            });
            return;
          case "cancel":
            await circleFetch(this.ctx, `/workflow/${enc(workflowId)}/cancel`, { method: "POST" });
            return;
          case "approve":
            if (approvalId) {
              await circleFetch(
                this.ctx,
                `/workflow/${enc(workflowId)}/approve/${enc(approvalId)}`,
                {
                  method: "POST",
                },
              );
              return;
            }
        }
      }
    }
    if (typeId === "trigger" && (actionId === "enable" || actionId === "disable")) {
      const { rest } = splitScoped(id);
      const [projectId, triggerId] = rest.split("/");
      await circleFetch(
        this.ctx,
        `/projects/${enc(projectId ?? "")}/triggers/${enc(triggerId ?? "")}`,
        {
          method: "PATCH",
          body: { disabled: actionId === "disable" },
        },
      );
      return;
    }
    throw new Error(`CircleCI plugin: unknown action "${actionId}" for "${typeId}"`);
  }

  async exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): Promise<CredentialExport> {
    if (typeId !== "runner-resource-class" || formatId !== "runner-token") {
      throw new Error(`CircleCI plugin: cannot export "${formatId}" for "${typeId}"`);
    }
    const id = externalIdOf(resourceId);
    const token = await circleV3<{ attributes?: { token?: string; nickname?: string } }>(
      this.ctx,
      "/runner/tokens",
      {
        method: "POST",
        body: {
          data: {
            attributes: { nickname: `infrawrench-${new Date().toISOString().slice(0, 10)}` },
            references: { resource_class: { id } },
          },
        },
      },
    );
    const value = token?.attributes?.token;
    if (!value) throw new Error("CircleCI did not return a runner token");
    return {
      content: value,
      filename: "circleci-runner-token.txt",
      mimeType: "text/plain",
      fields: [
        { label: "Token", value, sensitive: true, hint: "Only shown once" },
        { label: "Nickname", value: token.attributes?.nickname ?? "" },
      ],
      warning:
        "Save this token now: CircleCI does not show it again. Use it as the runner agent's auth token.",
    };
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  renderDetail(resource: ResourceInstance): DetailViewSchema {
    return renderCircleDetail(resource, this.rates);
  }

  renderSidebarItem(resource: ResourceInstance): SidebarItemSchema {
    return renderCircleSidebar(resource);
  }
}

/** Attach detail-only data to a resource for the renderer. */
function stash(r: ResourceInstance, data: Record<string, unknown>): ResourceInstance {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) extra[k] = JSON.stringify(v);
  return { ...r, resolvedOutputs: { ...r.resolvedOutputs, ...extra } };
}
