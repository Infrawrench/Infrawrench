import type { Credentials } from "./plugin.js";
import { attempt, runPluginEffect } from "@infrawrench/plugin-base/effect";
import type { PluginEffect } from "@infrawrench/plugin-base";
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
import {
  externalIdOf,
  pathEncode,
  requireListPage,
  rethrowIncompleteList,
  type NoSlashString,
} from "@infrawrench/plugin-base";
import type { ApiBody } from "@infrawrench/plugin-base";
import type { CircleApi, CircleContext } from "./api.js";
import { circleApi, slugSegment, statusOf, undefinedIfRefused } from "./api.js";
import type { operations } from "./api-types.v2.gen.js";
import { fetchCircleCostData } from "./cost-data.js";
import type {
  CircleCollaboration,
  CircleContextItem,
  CirclePipeline,
  ContextVariable,
  OrgSummary,
  PipelineDefinition,
  RunnerResourceClass,
  SummaryMetrics,
  Timetable,
  WorkflowMetrics,
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

const REPORTING_WINDOW = "last-30-days";
/** Pipelines listed: the most recent across the organization. */
const PIPELINE_LIMIT = 50;

/** The first rows of what a detail view shows beside a resource: its size was never the point. */
const DETAIL_ROWS = { maxPages: 10, partial: true };

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

interface ProjectRef {
  slug: string;
  name: string;
  id?: string;
}

/**
 * The list of an answer whose document marks `items` optional, so an empty answer is
 * an empty list. Anything else without one is not an answer to read as no rows.
 */
function optionalItems<T>(body: { items?: T[] | null } | undefined, path: string): T[] {
  if (body && Object.keys(body).length === 0) return [];
  return requireListPage(body?.items, { vendor: "CircleCI", path, key: "items", page: body });
}

/** One id for a write's path. A blank one is refused: it would aim the write at another route. */
function idSegment(value: string | undefined, what: string): NoSlashString {
  if (!value) throw new Error(`CircleCI plugin: refusing to act on a blank ${what}`);
  return pathEncode(value);
}

/** The route of a context variable, from its `<context id>/<name>` id. */
function contextVariableRoute(id: string) {
  const [contextId, ...nameParts] = id.split("/");
  return `/context/${idSegment(contextId, "context id")}/environment-variable/${idSegment(nameParts.join("/"), "variable name")}` as const;
}

/** The route of a trigger, from its `<project slug>/<project id>/<trigger id>` id. */
function triggerRoute(id: string) {
  const [projectId, triggerId] = splitScoped(id).rest.split("/");
  return `/projects/${idSegment(projectId, "project id")}/triggers/${idSegment(triggerId, "trigger id")}` as const;
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

function names<T extends string>(
  raw: string | undefined,
  label: string,
  allowed: readonly T[],
): T[] {
  const parts = (raw ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase().slice(0, 3))
    .filter(Boolean);
  const isAllowed = (p: string): p is T => allowed.some((a) => a === p);
  const named: T[] = [];
  for (const p of parts) {
    if (!isAllowed(p)) {
      throw new Error(`CircleCI plugin: "${label}" accepts ${allowed.join(", ")}; got "${p}"`);
    }
    named.push(p);
  }
  return named;
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
      : { "days-of-week": daysOfWeek.length > 0 ? daysOfWeek : [...DAYS] }),
    ...(months.length > 0 ? { months } : {}),
  };
}

/** Any JSON object: its values go through as typed, and CircleCI checks them against the config. */
function isParameters(value: unknown): value is Record<string, string | number | boolean> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
    if (!isParameters(parsed)) {
      throw new Error(
        'CircleCI plugin: pipeline parameters must be a JSON object, e.g. {"deploy": true}',
      );
    }
    params = parsed;
  }
  const b = (branch ?? "").trim();
  return b ? { ...params, branch: b } : params;
}

export class CircleCIClient implements PluginClient {
  private readonly ctx: CircleContext;
  private readonly api: CircleApi;
  private readonly orgValue: string;
  private readonly rates: CircleRates;
  private orgCache: Promise<CircleCollaboration> | undefined;
  private projectsCache: Promise<ProjectRef[]> | undefined;
  private pipelinesCache: Promise<CirclePipeline[]> | undefined;

  constructor(credentials: Credentials, services?: HostServices) {
    const token = (credentials["apiToken"] ?? "").trim();
    if (!token) throw new Error("CircleCI plugin: missing apiToken credential");
    this.ctx = { token, ...(services?.http ? { http: services.http } : {}) };
    this.api = circleApi(this.ctx);
    this.orgValue = (credentials["organization"] ?? "").trim();
    if (!this.orgValue) throw new Error("CircleCI plugin: pick an organization");
    this.rates = parseRates(credentials);
  }

  // -------------------------------------------------------------------------
  // Shared lookups
  // -------------------------------------------------------------------------

  private org(): Promise<CircleCollaboration> {
    this.orgCache ??= this.api.v2
      .get("/me/collaborations")
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

  private async readOrgSummary(projectNames?: string[]): Promise<OrgSummary> {
    const org = await this.org();
    return this.api.v2.get(`/insights/${slugSegment(org.slug)}/summary`, {
      query: {
        "reporting-window": REPORTING_WINDOW,
        ...(projectNames ? { "project-names": projectNames } : {}),
      },
    });
  }

  /** The summary for its metrics, which a resource can go without for one sync. */
  private orgSummary(projectNames?: string[]): Promise<OrgSummary | undefined> {
    return this.readOrgSummary(projectNames).catch(() => undefined);
  }

  private recentPipelines(): Promise<CirclePipeline[]> {
    this.pipelinesCache ??= this.org()
      .then((org) =>
        // Rolling window: the newest N. Older rows falling off is what this type means.
        this.api.v2Paged.getAll("/pipeline", "items", {
          query: { "org-slug": org.slug },
          maxPages: 3,
          partial: true,
        }),
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
   *
   * Everything under a project is pruned with it, so only a source refusing the
   * token may be left out. A source that failed fails the list.
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
        ? this.api.v3Paged
            .getAll("/projects", "data", { query: { "filter[org_id]": org.id, "page[limit]": 50 } })
            .catch(undefinedIfRefused)
        : Promise.resolve(undefined),
      this.recentPipelines().catch(undefinedIfRefused),
    ]);
    const bySlug = new Map<string, ProjectRef>();
    // Slugs seen on pipelines; their names need a lookup for opaque slugs.
    const pipelineSlugs = [...new Set((pipelines ?? []).map((p) => p.project_slug))];
    const named = new Map<string, ProjectRef>();
    for (const slug of pipelineSlugs) {
      if (vcsSlugs) {
        named.set(slug.split("/").slice(2).join("/"), {
          slug,
          name: slug.split("/").slice(2).join("/"),
        });
      } else {
        const p = await this.api.v2.get(`/project/${slugSegment(slug)}`).catch(undefinedIfRefused);
        if (p) named.set(p.name, { slug: p.slug, name: p.name, id: p.id });
      }
    }
    let names: Array<{ name: string; id?: string }>;
    if (listed) {
      names = listed.map((p) => ({ name: p.attributes?.name ?? p.id, id: p.id }));
    } else {
      const summary = await this.readOrgSummary().catch(undefinedIfRefused);
      if (!summary && !pipelines) {
        throw new Error(
          "CircleCI plugin: could not list this organization's projects: API v3, Insights and pipelines all refused the token.",
        );
      }
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
    const known = (await this.projects().catch((): ProjectRef[] => [])).find(
      (p) => p.slug === slug,
    );
    if (known?.id) return known.id;
    return (await this.api.v2.get(`/project/${slugSegment(slug)}`)).id;
  }

  private async contexts(): Promise<CircleContextItem[]> {
    const org = await this.org();
    return this.api.v2Paged.getAll("/context", "items", {
      query: {
        ...(org.id ? { "owner-id": org.id } : { "owner-slug": org.slug }),
        "owner-type": "organization",
      },
    });
  }

  private contextVariables(contextId: string): Promise<ContextVariable[]> {
    return this.api.v2Paged.getAll(
      `/context/${pathEncode(contextId)}/environment-variable`,
      "items",
    );
  }

  private async runnerClasses(): Promise<RunnerResourceClass[]> {
    const org = await this.org();
    return this.api.v3Paged.getAll("/runner/resource-classes", "data", {
      query: { "filter[org_id]": org.id },
    });
  }

  private async runnerAgents() {
    const org = await this.org();
    return this.api.v3Paged.getAll("/runner/agents", "data", {
      query: { "filter[org_id]": org.id, "page[limit]": 250 },
    });
  }

  /**
   * A class's connected runners, by its id: the one filter that needs nothing but
   * what every class has. Unknown when the read fails, which is not the same as none.
   */
  private runnerCount(classId: string): Promise<number | undefined> {
    return this.api.v3Paged
      .getAll("/runner/agents", "data", {
        query: { "filter[resource_class_id]": classId, "page[limit]": 250 },
      })
      .then((agents) => agents.length)
      .catch((err: unknown) => {
        rethrowIncompleteList(err);
        return undefined;
      });
  }

  /** Waiting and running task counts for a runner resource class (runner API). */
  private async runnerTasks(
    resourceClass: string,
  ): Promise<{ unclaimed?: number; running?: number }> {
    const { runner } = this.api;
    const [waiting, running] = await Promise.all([
      runner
        .get("/runner/tasks", { query: { "resource-class": resourceClass } })
        .catch(() => undefined),
      runner
        .get("/runner/tasks/running", { query: { "resource-class": resourceClass } })
        .catch(() => undefined),
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
    return this.api.v2Paged.getAll(`/insights/${slugSegment(slug)}/workflows`, "items", {
      query: { "all-branches": true, "reporting-window": REPORTING_WINDOW },
    });
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
    const path = `/projects/${pathEncode(projectId)}/pipeline-definitions` as const;
    return optionalItems(await this.api.v2.get(path), path);
  }

  private async triggersFor(
    accountId: string,
    p: ProjectRef & { id: string },
  ): Promise<ResourceInstance[]> {
    const out: ResourceInstance[] = [];
    for (const def of await this.pipelineDefinitions(p.id)) {
      const path =
        `/projects/${pathEncode(p.id)}/pipeline-definitions/${pathEncode(def.id)}/triggers` as const;
      const triggers = optionalItems(await this.api.v2.get(path), path);
      out.push(...triggers.map((t) => mapTrigger(accountId, p.slug, p.id, def, t)));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  listResources(typeId: string, accountId: string): PluginEffect<ResourceInstance[]> {
    return attempt(async () => {
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
            const vars = await this.contextVariables(c.id).catch((err: unknown) => {
              rethrowIncompleteList(err);
              return undefined;
            });
            out.push(mapContext(accountId, c, vars));
          }
          return out;
        }
        case "context-variable": {
          const out: ResourceInstance[] = [];
          for (const c of await this.contexts()) {
            const vars = await this.contextVariables(c.id).catch((err: unknown) => {
              // A context the token may not read, or one just deleted. Anything else
              // would prune this context's variables.
              if (statusOf(err) === 403 || statusOf(err) === 404) return [];
              throw err;
            });
            out.push(...vars.map((v) => mapContextVariable(accountId, c, v)));
          }
          return out;
        }
        case "project-variable":
          return this.perProject(async (p) =>
            (await this.api.v2Paged.getAll(`/project/${slugSegment(p.slug)}/envvar`, "items")).map(
              (v) => mapProjectVariable(accountId, p.slug, v),
            ),
          );
        case "schedule":
          return this.perProject(async (p) =>
            (
              await this.api.v2Paged.getAll(`/project/${slugSegment(p.slug)}/schedule`, "items")
            ).map((s) =>
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
          const out: ResourceInstance[] = [];
          for (const rc of classes) {
            const name = rc.attributes?.resource_class ?? "";
            out.push(
              mapRunnerResourceClass(
                accountId,
                rc,
                await this.runnerCount(rc.id),
                name ? await this.runnerTasks(name) : {},
              ),
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
    });
  }

  // -------------------------------------------------------------------------
  // Single reads
  // -------------------------------------------------------------------------

  getResource(
    typeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      const price = this.rates.pricePerCredit;
      switch (typeId) {
        case "organization": {
          const [org, summary] = await Promise.all([this.org(), this.orgSummary()]);
          const r = mapOrganization(accountId, org, summary, price);
          return summary ? stash(r, { [DETAIL_KEYS.orgSummary]: summary }) : r;
        }
        case "project": {
          const p = await this.api.v2.get(`/project/${slugSegment(id)}`);
          const [summary, workflows, flaky] = await Promise.all([
            this.orgSummary([p.name]),
            this.workflowMetrics(p.slug).catch(() => undefined),
            this.api.v2.get(`/insights/${slugSegment(p.slug)}/flaky-tests`).catch(() => undefined),
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
          const insights =
            `/insights/${slugSegment(projectSlug)}/workflows/${pathEncode(name)}` as const;
          const [workflows, jobs, runs] = await Promise.all([
            this.workflowMetrics(projectSlug),
            this.api.v2Paged
              .getAll(`${insights}/jobs`, "items", {
                query: { "all-branches": true, "reporting-window": REPORTING_WINDOW },
                maxPages: 3,
                partial: true,
              })
              .catch(() => undefined),
            this.api.v2.get(insights, { query: { "all-branches": true } }).catch(() => undefined),
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
          const p = await this.api.v2.get(`/pipeline/${pathEncode(id)}`);
          const workflows = await this.api.v2Paged.getAll(
            `/pipeline/${pathEncode(id)}/workflow`,
            "items",
            DETAIL_ROWS,
          );
          const detailed: PipelineWorkflowDetail[] = [];
          for (const w of workflows) {
            const jobs = await this.api.v2Paged
              .getAll(`/workflow/${pathEncode(w.id)}/job`, "items", DETAIL_ROWS)
              .catch(() => undefined);
            detailed.push({ ...w, ...(jobs ? { jobs } : {}) });
          }
          return stash(mapPipeline(accountId, p), { [DETAIL_KEYS.pipelineWorkflows]: detailed });
        }
        case "context": {
          const c = await this.api.v2.get(`/context/${pathEncode(id)}`);
          const [vars, restrictions] = await Promise.all([
            this.contextVariables(id).catch(() => undefined),
            this.api.v2Paged
              .getAll(`/context/${pathEncode(id)}/restrictions`, "items")
              .catch(() => undefined),
          ]);
          const r = mapContext(accountId, c, vars, restrictions);
          return restrictions ? stash(r, { [DETAIL_KEYS.restrictions]: restrictions }) : r;
        }
        case "context-variable": {
          const [contextId, ...nameParts] = id.split("/");
          const name = nameParts.join("/");
          const c = await this.api.v2.get(`/context/${pathEncode(contextId ?? "")}`);
          const v = (await this.contextVariables(c.id)).find((x) => x.variable === name);
          if (!v) throw new Error(`CircleCI plugin: context variable "${name}" not found`);
          return mapContextVariable(accountId, c, v);
        }
        case "project-variable": {
          const { projectSlug, rest: name } = splitScoped(id);
          const v = await this.api.v2.get(
            `/project/${slugSegment(projectSlug)}/envvar/${pathEncode(name)}`,
          );
          return mapProjectVariable(accountId, projectSlug, v);
        }
        case "schedule":
          return mapSchedule(accountId, await this.api.v2.get(`/schedule/${pathEncode(id)}`));
        case "trigger": {
          const { projectSlug, rest } = splitScoped(id);
          const [projectId, triggerId] = rest.split("/");
          const t = await this.api.v2.get(
            `/projects/${pathEncode(projectId ?? "")}/triggers/${pathEncode(triggerId ?? "")}`,
          );
          return mapTrigger(accountId, projectSlug, projectId ?? "", {}, t);
        }
        case "runner-resource-class": {
          const rc = (await this.api.v3.get(`/runner/resource-classes/${pathEncode(id)}`))?.data;
          if (!rc) throw new Error(`CircleCI plugin: runner resource class "${id}" not found`);
          const name = rc.attributes?.resource_class ?? "";
          return mapRunnerResourceClass(
            accountId,
            rc,
            await this.runnerCount(rc.id),
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
    });
  }

  resolveOutput(
    typeId: string,
    resourceId: string,
    outputKey: string,
    accountId: string,
  ): PluginEffect<string> {
    return attempt(async () => {
      const resource = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
      const resolved = resource.resolvedOutputs[outputKey];
      if (resolved !== undefined) return resolved;
      const field = resource.fields[outputKey];
      if (field !== undefined) return String(field);
      throw new Error(`CircleCI plugin: cannot resolve output "${outputKey}" for type "${typeId}"`);
    });
  }

  // -------------------------------------------------------------------------
  // Stats, metrics, costs
  // -------------------------------------------------------------------------

  fetchDashboardStats(
    resourceTypeId: string,
    resourceId: string,
    accountId: string,
  ): PluginEffect<DashboardStat[]> {
    return attempt(async () => {
      const r = await runPluginEffect(this.getResource(resourceTypeId, resourceId, accountId));
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
              value:
                typeof f["estimatedCost30d"] === "number" ? `$${n(f["estimatedCost30d"])}` : "—",
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
    });
  }

  fetchMetricSeries(
    resourceTypeId: string,
    resourceId: string,
    _accountId: string,
    timeRange?: { startMs: number; endMs: number },
  ): PluginEffect<MetricSeries[]> {
    return attempt(async () => {
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
    });
  }

  fetchCostData(_accountId: string, range: CostFetchRange): PluginEffect<CostRow[]> {
    return attempt(async () => {
      const org = await this.org();
      return fetchCircleCostData(this.ctx, org.id, this.rates, range);
    });
  }

  // -------------------------------------------------------------------------
  // Create / update / delete
  // -------------------------------------------------------------------------

  private async projectField(parentResourceId?: string): Promise<CreateFieldConfig[]> {
    if (parentResourceId) return [];
    const projects = await this.projects().catch((): ProjectRef[] => []);
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

  getCreateConfig(typeId: string, parentResourceId?: string): PluginEffect<CreateResourceConfig> {
    return attempt(async () => {
      const parent = parentResourceId ? externalIdOf(parentResourceId) : undefined;
      switch (typeId) {
        case "pipeline": {
          const defs = parent
            ? await this.projectId(parent)
                .then((pid) => this.pipelineDefinitions(pid))
                .catch((): PipelineDefinition[] => [])
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
          const contexts = parent ? [] : await this.contexts().catch((): CircleContextItem[] => []);
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
              {
                key: "name",
                label: "Name",
                kind: "text",
                required: true,
                placeholder: "NPM_TOKEN",
              },
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
                .catch((): PipelineDefinition[] => [])
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
          const classes = await this.runnerClasses().catch((): RunnerResourceClass[] => []);
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
    });
  }

  createResource(
    typeId: string,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ): PluginEffect<ResourceInstance> {
    return attempt(async () => {
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
          if (!provider || !orgName || rest.length === 0) {
            throw new Error(`CircleCI plugin: "${project}" is not a CircleCI slug`);
          }
          let created: { id?: string; message?: string } | undefined;
          try {
            created = await this.api.v2.post(
              `/project/${slugSegment(provider)}/${slugSegment(orgName)}/${slugSegment(rest.join("/"))}/pipeline/run`,
              {
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
            created = await this.api.v2.post(`/project/${slugSegment(project)}/pipeline`, {
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
          return runPluginEffect(
            this.getResource("pipeline", `${accountId}:pipeline:${created.id}`, accountId),
          );
        }
        case "context": {
          const org = await this.org();
          const c = await this.api.v2.post("/context", {
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
          await this.api.v2.put(
            `/context/${pathEncode(contextId)}/environment-variable/${pathEncode(name)}`,
            { body: { value: fields["value"] ?? "" } },
          );
          return runPluginEffect(
            this.getResource(
              "context-variable",
              `${accountId}:context-variable:${contextId}/${name}`,
              accountId,
            ),
          );
        }
        case "project-variable": {
          if (!project) throw new Error('CircleCI plugin: "Project" is required');
          const v = await this.api.v2.post(`/project/${slugSegment(project)}/envvar`, {
            body: { name: need("name", "Name"), value: fields["value"] ?? "" },
          });
          return mapProjectVariable(accountId, project, v);
        }
        case "schedule": {
          if (!project) throw new Error('CircleCI plugin: "Project" is required');
          const description = (fields["description"] ?? "").trim();
          const s = await this.api.v2.post(`/project/${slugSegment(project)}/schedule`, {
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
          const t = await this.api.v2.post(
            `/projects/${pathEncode(projectId)}/pipeline-definitions/${pathEncode(def.id)}/triggers`,
            {
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
          const created = await this.api.v3.post("/runner/resource-classes", {
            body: {
              data: {
                attributes: {
                  resource_class: name,
                  description: need("description", "Description"),
                },
                references: { org: { id: org.id } },
              },
            },
          });
          const rc = created?.data;
          if (!rc) throw new Error("CircleCI did not return the new resource class");
          return mapRunnerResourceClass(accountId, rc, 0, {});
        }
        default:
          throw new Error(`CircleCI plugin: cannot create "${typeId}" from Infrawrench`);
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
      switch (typeId) {
        case "context-variable": {
          const value = fields["value"] ?? "";
          if (value) await this.api.v2.put(contextVariableRoute(id), { body: { value } });
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "project-variable": {
          const value = fields["value"] ?? "";
          const { projectSlug, rest: name } = splitScoped(id);
          if (value) {
            await this.api.v2.post(`/project/${slugSegment(projectSlug)}/envvar`, {
              body: { name, value },
            });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "schedule": {
          const route = `/schedule/${idSegment(id, "schedule id")}` as const;
          const current = await runPluginEffect(this.getResource(typeId, resourceId, accountId));
          const merged: Record<string, string> = {};
          for (const [k, v] of Object.entries(current.fields)) merged[k] = String(v);
          Object.assign(merged, fields);
          const body: ApiBody<operations["updateSchedule"]> = {};
          if ("name" in fields) body["name"] = (fields["name"] ?? "").trim();
          if ("description" in fields) body["description"] = (fields["description"] ?? "").trim();
          if (
            ["perHour", "hoursOfDay", "daysOfWeek", "daysOfMonth", "months"].some(
              (k) => k in fields,
            )
          ) {
            body["timetable"] = buildTimetable(merged);
          }
          if ("branch" in fields || "parameters" in fields) {
            body["parameters"] = buildParameters(merged["parameters"], merged["branch"]);
          }
          if (Object.keys(body).length > 0) {
            await this.api.v2.patch(route, { body });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "trigger": {
          const route = triggerRoute(id);
          const body: ApiBody<operations["updateTrigger"]> = {};
          if ("checkoutRef" in fields) body["checkout_ref"] = (fields["checkoutRef"] ?? "").trim();
          if ("configRef" in fields) body["config_ref"] = (fields["configRef"] ?? "").trim();
          if ("cronExpression" in fields) {
            body["event_source"] = {
              schedule: { cron_expression: (fields["cronExpression"] ?? "").trim() },
            };
          }
          if (Object.keys(body).length > 0) {
            await this.api.v2.patch(route, { body });
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        case "runner-resource-class": {
          if ("description" in fields) {
            await this.api.v3.post(
              `/runner/resource-classes/${idSegment(id, "resource class id")}/update`,
              {
                body: { description: (fields["description"] ?? "").trim() },
              },
            );
          }
          return runPluginEffect(this.getResource(typeId, resourceId, accountId));
        }
        default:
          throw new Error(`CircleCI plugin: cannot edit "${typeId}" from Infrawrench`);
      }
    });
  }

  deleteResource(typeId: string, resourceId: string, _accountId: string): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      switch (typeId) {
        case "context":
          await this.api.v2.delete(`/context/${idSegment(id, "context id")}`);
          return;
        case "context-variable":
          await this.api.v2.delete(contextVariableRoute(id));
          return;
        case "project-variable": {
          const { projectSlug, rest } = splitScoped(id);
          await this.api.v2.delete(
            `/project/${slugSegment(projectSlug)}/envvar/${idSegment(rest, "variable name")}`,
          );
          return;
        }
        case "schedule":
          await this.api.v2.delete(`/schedule/${idSegment(id, "schedule id")}`);
          return;
        case "trigger":
          await this.api.v2.delete(triggerRoute(id));
          return;
        case "runner-resource-class":
          // `force` also revokes the class's runner tokens; without it a class
          // that still has tokens cannot be deleted at all.
          await this.api.v3.delete(
            `/runner/resource-classes/${idSegment(id, "resource class id")}`,
            {
              query: { force: "true" },
            },
          );
          return;
        default:
          throw new Error(`CircleCI plugin: cannot delete "${typeId}" from Infrawrench`);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Actions and credentials
  // -------------------------------------------------------------------------

  invokeAction(
    typeId: string,
    resourceId: string,
    actionId: string,
    _accountId: string,
  ): PluginEffect<void> {
    return attempt(async () => {
      const id = externalIdOf(resourceId);
      if (typeId === "pipeline" || typeId === "workflow") {
        const [verb, workflowId, approvalId] = actionId.split(":");
        if (workflowId) {
          switch (verb) {
            case "rerun":
              await this.api.v2.post(`/workflow/${pathEncode(workflowId)}/rerun`, { body: {} });
              return;
            case "rerun-failed":
              await this.api.v2.post(`/workflow/${pathEncode(workflowId)}/rerun`, {
                body: { from_failed: true },
              });
              return;
            case "cancel":
              await this.api.v2.post(`/workflow/${pathEncode(workflowId)}/cancel`);
              return;
            case "approve":
              if (approvalId) {
                await this.api.v2.post(
                  `/workflow/${pathEncode(workflowId)}/approve/${pathEncode(approvalId)}`,
                );
                return;
              }
          }
        }
      }
      if (typeId === "trigger" && (actionId === "enable" || actionId === "disable")) {
        await this.api.v2.patch(triggerRoute(id), { body: { disabled: actionId === "disable" } });
        return;
      }
      throw new Error(`CircleCI plugin: unknown action "${actionId}" for "${typeId}"`);
    });
  }

  exportCredential(
    typeId: string,
    resourceId: string,
    _accountId: string,
    formatId: string,
  ): PluginEffect<CredentialExport> {
    return attempt(async () => {
      if (typeId !== "runner-resource-class" || formatId !== "runner-token") {
        throw new Error(`CircleCI plugin: cannot export "${formatId}" for "${typeId}"`);
      }
      const id = externalIdOf(resourceId);
      const created = await this.api.v3.post("/runner/tokens", {
        body: {
          data: {
            attributes: { nickname: `infrawrench-${new Date().toISOString().slice(0, 10)}` },
            references: { resource_class: { id } },
          },
        },
      });
      const token = created?.data;
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
    });
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
