import type { ApiListItem, ApiResponse, ResourceInstance } from "@infrawrench/plugin-base";
import { APP_BASE } from "./api.js";
import type { operations as V2 } from "./api-types.v2.gen.js";
import type { operations as V3 } from "./api-types.v3.gen.js";

export const PLUGIN_ID = "circleci";

// ---------------------------------------------------------------------------
// API shapes, from the OpenAPI documents (`../plugingen.json`)
// ---------------------------------------------------------------------------

export type CircleCollaboration = ApiListItem<V2["getCollaborations"], null>;
export type CircleProject = ApiResponse<V2["getProjectBySlug"]>;
export type OrgSummary = ApiResponse<V2["getOrgSummaryData"]>;
export type SummaryMetrics = OrgSummary["org_project_data"][number]["metrics"];
export type WorkflowMetrics = ApiListItem<V2["getProjectWorkflowMetrics"], "items">;
export type JobMetrics = ApiListItem<V2["getProjectWorkflowJobMetrics"], "items">;
export type WorkflowRun = ApiListItem<V2["getProjectWorkflowRuns"], "items">;
export type FlakyTest = ApiListItem<V2["getFlakyTests"], "flaky-tests">;
export type CirclePipeline = ApiListItem<V2["listPipelines"], "items">;
export type CircleWorkflow = ApiListItem<V2["listWorkflowsByPipelineId"], "items">;
export type CircleJob = ApiListItem<V2["listWorkflowJobs"], "items">;
export type CircleContextItem = ApiListItem<V2["listContexts"], "items">;
export type ContextVariable = ApiListItem<V2["listEnvironmentVariablesFromContext"], "items">;
export type ContextRestriction = ApiListItem<V2["getContextRestrictions"], "items">;
export type ProjectVariable = ApiListItem<V2["listEnvVars"], "items">;
export type CircleSchedule = ApiListItem<V2["listSchedulesForProject"], "items">;
export type Timetable = CircleSchedule["timetable"];
export type PipelineDefinition = ApiListItem<V2["listPipelineDefinitions"], "items">;
export type CircleTrigger = ApiListItem<V2["listPipelineDefinitionTriggers"], "items">;
export type RunnerResourceClass = ApiListItem<V3["get-runner-resource-classes"], "data">;
export type CircleRunner = ApiListItem<V3["get-runner-agents"], "data">;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FieldValue = string | number | boolean | undefined | null;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  outputs: Record<string, string | undefined> = {},
  parent?: { typeId: string; externalId: string },
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (
      v !== undefined &&
      v !== null &&
      v !== "" &&
      !(typeof v === "number" && !Number.isFinite(v))
    )
      clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    ...(parent ? { parentResourceId: `${accountId}:${parent.typeId}:${parent.externalId}` } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Success rates arrive as fractions (0.93); fields carry percentages. */
export const pct = (rate: number | undefined): number | undefined =>
  rate === undefined ? undefined : round(rate * 100, 1);

/** Credits to dollars at the configured price. */
export const toUsd = (credits: number | undefined, pricePerCredit: number): number | undefined =>
  credits === undefined ? undefined : round(credits * pricePerCredit);

/**
 * Project slugs are always three segments (`gh/acme/api`, `bb/acme/api`, or
 * `circleci/<org id>/<project id>` for GitHub App and standalone projects), so
 * a composite id appends after them.
 */
export function splitScoped(id: string): { projectSlug: string; rest: string } {
  const parts = id.split("/");
  return { projectSlug: parts.slice(0, 3).join("/"), rest: parts.slice(3).join("/") };
}

const enc = encodeURIComponent;

/** `gh/acme/api` -> `github/acme/api` for app.circleci.com links. */
export function appSlug(slug: string): string {
  const [vcs, ...rest] = slug.split("/");
  const provider = vcs === "gh" ? "github" : vcs === "bb" ? "bitbucket" : (vcs ?? "");
  return [provider, ...rest].join("/");
}

export function projectUrl(slug: string): string {
  return `${APP_BASE}/pipelines/${appSlug(slug)}`;
}

export function orgUrl(orgSlug: string): string {
  return `${APP_BASE}/pipelines/${appSlug(orgSlug)}`;
}

export function pipelineUrl(slug: string, number: number): string {
  return `${APP_BASE}/pipelines/${appSlug(slug)}/${number}`;
}

export function workflowUrl(slug: string, pipelineNumber: number, workflowId: string): string {
  return `${APP_BASE}/pipelines/${appSlug(slug)}/${pipelineNumber}/workflows/${workflowId}`;
}

export function insightsUrl(slug: string, workflow?: string): string {
  return `${APP_BASE}/insights/${appSlug(slug)}${workflow ? `/workflows/${enc(workflow)}/overview` : ""}`;
}

/** Hours, days and months as the comma lists the schedule fields carry. */
export function describeTimetable(t: Timetable | undefined): string {
  if (!t) return "";
  const hours = (t["hours-of-day"] ?? []).slice().sort((a, b) => a - b);
  const parts = [`${t["per-hour"] ?? 1}x per hour`];
  if (hours.length > 0 && hours.length < 24)
    parts.push(`at ${hours.map((h) => `${h}:00`).join(", ")} UTC`);
  else parts.push("every hour");
  if (t["days-of-week"]?.length) parts.push(`on ${t["days-of-week"].join(", ")}`);
  if (t["days-of-month"]?.length) parts.push(`on day ${t["days-of-month"].join(", ")}`);
  if (t.months?.length && t.months.length < 12) parts.push(`in ${t.months.join(", ")}`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function mapOrganization(
  accountId: string,
  org: CircleCollaboration,
  summary: OrgSummary | undefined,
  pricePerCredit: number,
): ResourceInstance {
  const m = summary?.org_data?.metrics;
  return instance(
    accountId,
    "organization",
    org.id,
    org.name,
    {
      name: org.name,
      slug: org.slug,
      vcsType: org["vcs-type"],
      credits30d: m?.total_credits_used,
      estimatedCost30d: toUsd(m?.total_credits_used, pricePerCredit),
      runs30d: m?.total_runs,
      successRate30d: pct(m?.success_rate),
      projectCount: summary?.all_projects?.length,
      orgId: org.id,
    },
    { slug: org.slug, orgId: org.id, url: orgUrl(org.slug) },
  );
}

export function mapProject(
  accountId: string,
  project: Pick<CircleProject, "slug" | "name"> & Partial<CircleProject>,
  metrics: SummaryMetrics | undefined,
  pricePerCredit: number,
): ResourceInstance {
  return instance(
    accountId,
    "project",
    project.slug,
    project.name,
    {
      name: project.name,
      slug: project.slug,
      vcsUrl: project.vcs_info?.vcs_url,
      vcsProvider: project.vcs_info?.provider,
      defaultBranch: project.vcs_info?.default_branch,
      credits30d: metrics?.total_credits_used,
      estimatedCost30d: toUsd(metrics?.total_credits_used, pricePerCredit),
      runs30d: metrics?.total_runs,
      successRate30d: pct(metrics?.success_rate),
      durationSecs30d: metrics?.total_duration_secs,
      projectId: project.id,
    },
    { slug: project.slug, projectId: project.id, url: projectUrl(project.slug) },
  );
}

export function mapWorkflow(
  accountId: string,
  projectSlug: string,
  w: WorkflowMetrics,
): ResourceInstance {
  const m = w.metrics;
  return instance(
    accountId,
    "workflow",
    `${projectSlug}/${w.name}`,
    w.name,
    {
      name: w.name,
      projectSlug,
      totalRuns: m?.total_runs,
      successRate: pct(m?.success_rate),
      failedRuns: m?.failed_runs,
      durationMedianSecs: m?.duration_metrics?.median,
      durationP95Secs: m?.duration_metrics?.p95,
      credits: m?.total_credits_used,
      mttrSecs: m?.mttr,
      throughput: m?.throughput === undefined ? undefined : round(m.throughput),
    },
    { name: w.name, url: insightsUrl(projectSlug, w.name) },
    { typeId: "project", externalId: projectSlug },
  );
}

export function mapPipeline(accountId: string, p: CirclePipeline): ResourceInstance {
  return instance(
    accountId,
    "pipeline",
    p.id,
    `${p.project_slug.split("/").pop() ?? p.project_slug} #${p.number}`,
    {
      number: p.number,
      projectSlug: p.project_slug,
      state: p.state,
      branch: p.vcs?.branch,
      tag: p.vcs?.tag,
      revision: p.vcs?.revision?.slice(0, 12),
      commitSubject: p.vcs?.commit?.subject,
      trigger: p.trigger?.type,
      actor: p.trigger?.actor?.login,
      createdAt: p.created_at,
      errors: (p.errors ?? []).map((e) => e.message).join("; "),
    },
    { pipelineId: p.id, url: pipelineUrl(p.project_slug, p.number) },
    { typeId: "project", externalId: p.project_slug },
  );
}

export function mapContext(
  accountId: string,
  c: CircleContextItem,
  variables?: ContextVariable[],
  restrictions?: ContextRestriction[],
): ResourceInstance {
  return instance(
    accountId,
    "context",
    c.id,
    c.name,
    {
      name: c.name,
      variableCount: variables?.length,
      variables: variables?.map((v) => v.variable).join(", "),
      restrictions: restrictions
        ?.map((r) => `${r.restriction_type ?? ""}: ${r.name ?? r.restriction_value ?? ""}`)
        .join("; "),
      createdAt: c.created_at,
      contextId: c.id,
    },
    { contextId: c.id, name: c.name },
  );
}

export function mapContextVariable(
  accountId: string,
  context: CircleContextItem,
  v: ContextVariable,
): ResourceInstance {
  return instance(
    accountId,
    "context-variable",
    `${context.id}/${v.variable}`,
    v.variable,
    {
      name: v.variable,
      context: context.name,
      createdAt: v.created_at,
      updatedAt: v.updated_at,
    },
    { name: v.variable },
    { typeId: "context", externalId: context.id },
  );
}

export function mapProjectVariable(
  accountId: string,
  projectSlug: string,
  v: ProjectVariable,
): ResourceInstance {
  return instance(
    accountId,
    "project-variable",
    `${projectSlug}/${v.name}`,
    v.name,
    {
      name: v.name,
      maskedValue: v.value,
      projectSlug,
      createdAt: v["created-at"],
    },
    { name: v.name },
    { typeId: "project", externalId: projectSlug },
  );
}

export function mapSchedule(accountId: string, s: CircleSchedule): ResourceInstance {
  const slug = s["project-slug"] ?? "";
  const t = s.timetable;
  const { branch, ...rest } = s.parameters ?? {};
  return instance(
    accountId,
    "schedule",
    s.id,
    s.name,
    {
      name: s.name,
      description: s.description,
      perHour: t?.["per-hour"],
      hoursOfDay: t?.["hours-of-day"]?.join(","),
      daysOfWeek: t?.["days-of-week"]?.join(","),
      daysOfMonth: t?.["days-of-month"]?.join(","),
      months: t?.months?.join(","),
      branch: branch === undefined ? undefined : String(branch),
      parameters: Object.keys(rest).length > 0 ? JSON.stringify(rest) : undefined,
      timetable: describeTimetable(t),
      actor: s.actor?.login ?? s.actor?.name,
      projectSlug: slug,
      updatedAt: s["updated-at"],
    },
    { scheduleId: s.id },
    slug ? { typeId: "project", externalId: slug } : undefined,
  );
}

export function triggerSource(t: CircleTrigger): string {
  if (t.event_source?.schedule?.cron_expression) return "schedule";
  if (t.event_source?.webhook) return "webhook";
  return t.event_source?.provider ?? "";
}

export function mapTrigger(
  accountId: string,
  projectSlug: string,
  projectId: string,
  definition: { name?: string | undefined },
  t: CircleTrigger,
): ResourceInstance {
  const cron = t.event_source?.schedule?.cron_expression;
  const source = triggerSource(t);
  const label =
    t.event_name ||
    (cron ? `Schedule ${cron}` : t.event_preset ? t.event_preset.replace(/-/g, " ") : source);
  return instance(
    accountId,
    "trigger",
    `${projectSlug}/${projectId}/${t.id}`,
    label,
    {
      name: t.event_name,
      source,
      eventPreset: t.event_preset,
      cronExpression: cron,
      checkoutRef: t.checkout_ref,
      configRef: t.config_ref,
      disabled: t.disabled ?? false,
      pipelineDefinition: definition.name,
      repository: t.event_source?.repo?.full_name,
      projectSlug,
    },
    { triggerId: t.id },
    { typeId: "project", externalId: projectSlug },
  );
}

export function mapRunnerResourceClass(
  accountId: string,
  rc: RunnerResourceClass,
  runners: number | undefined,
  tasks: { unclaimed?: number; running?: number },
): ResourceInstance {
  const name = rc.attributes?.resource_class ?? rc.id;
  return instance(
    accountId,
    "runner-resource-class",
    rc.id,
    name,
    {
      name,
      description: rc.attributes?.description,
      runnerCount: runners,
      unclaimedTasks: tasks.unclaimed,
      runningTasks: tasks.running,
      resourceClassId: rc.id,
    },
    { name },
  );
}

/** The resource class an agent belongs to, by id and by name. */
export function runnerClassOf(r: CircleRunner): { id: string; name: string } {
  const ref = r.references?.resource_class;
  return { id: ref?.id ?? "", name: ref?.attributes?.resource_class ?? "" };
}

export function mapRunner(accountId: string, r: CircleRunner): ResourceInstance {
  const rc = runnerClassOf(r);
  const name = r.attributes?.name ?? r.id;
  return instance(
    accountId,
    "runner",
    r.id,
    name,
    {
      name,
      resourceClass: rc.name,
      busy: r.attributes?.is_busy,
      version: r.attributes?.version,
      firstConnected: r.attributes?.first_connected_at,
      lastConnected: r.attributes?.last_connected_at,
    },
    { name },
    rc.id ? { typeId: "runner-resource-class", externalId: rc.id } : undefined,
  );
}
