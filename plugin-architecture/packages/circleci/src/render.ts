import type {
  ActionNode,
  DetailViewSchema,
  KVItem,
  ResourceInstance,
  ResourceStatus,
  SchemaNode,
  SectionNode,
  SidebarItemSchema,
  TableRow,
} from "@infrawrench/plugin-base";
import { joinSubtitle, withMetricsCapability } from "@infrawrench/plugin-base";
import type {
  CircleJob,
  CircleWorkflow,
  ContextRestriction,
  FlakyTest,
  JobMetrics,
  OrgSummary,
  WorkflowMetrics,
  WorkflowRun,
} from "./mappers.js";
import { DEFAULT_METRICS_WINDOW_MS } from "./metrics.js";
import type { CircleRates } from "./rates.js";
import { RESOURCE_TYPES } from "./resource-types.js";

/** Keys under which `getResource` stashes detail-only data in `resolvedOutputs`. */
export const DETAIL_KEYS = {
  orgSummary: "__orgSummary__",
  workflows: "__workflows__",
  flakyTests: "__flakyTests__",
  jobs: "__jobs__",
  runs: "__runs__",
  pipelineWorkflows: "__pipelineWorkflows__",
  restrictions: "__restrictions__",
} as const;

/** A pipeline's workflow with its jobs, as stashed for the detail view. */
export interface PipelineWorkflowDetail extends CircleWorkflow {
  jobs?: CircleJob[];
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

const fmt = (n: unknown, digits = 0): string =>
  typeof n === "number" && Number.isFinite(n)
    ? n.toLocaleString("en-US", { maximumFractionDigits: digits })
    : "";

function usd(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Seconds as `1h 2m`, `3m 4s` or `5s`. */
export function duration(secs: unknown): string {
  if (typeof secs !== "number" || !Number.isFinite(secs)) return "";
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rest}s`;
  return `${rest}s`;
}

const pctText = (rate: number | undefined) =>
  rate === undefined ? "" : `${(Math.round(rate * 1000) / 10).toLocaleString("en-US")}%`;

function kv(items: Array<[string, unknown, boolean?]>): SchemaNode {
  const list: KVItem[] = [];
  for (const [key, value, copyable] of items) {
    const text = typeof value === "boolean" ? (value ? "Yes" : "No") : str(value);
    if (text === "") continue;
    list.push({ key, value: text, ...(copyable ? { copyable: true } : {}) });
  }
  return { kind: "key-value-list", items: list };
}

function section(title: string, children: SchemaNode[]): SectionNode {
  return { kind: "section", title, children };
}

function muted(content: string): SchemaNode {
  return { kind: "text", variant: "muted", content };
}

function openIn(url: string | undefined): ActionNode[] {
  return url
    ? [{ kind: "action", label: "Open in CircleCI", action: { type: "open-url", url } }]
    : [];
}

function action(
  label: string,
  actionId: string,
  successMessage: string,
  confirmMessage?: string,
): ActionNode {
  return {
    kind: "action",
    label,
    action: {
      type: "plugin-action",
      actionId,
      successMessage,
      ...(confirmMessage ? { confirmMessage } : {}),
    },
  };
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Workflow and job statuses as a status dot. */
export function runStatus(status: string): ResourceStatus {
  switch (status) {
    case "success":
      return "healthy";
    case "running":
    case "queued":
    case "on_hold":
    case "created":
    case "pending":
    case "setup":
    case "setup-pending":
      return "provisioning";
    case "failing":
    case "not_run":
    case "canceled":
    case "blocked":
      return "degraded";
    case "failed":
    case "error":
    case "errored":
    case "infrastructure_fail":
    case "timedout":
    case "unauthorized":
      return "error";
    default:
      return "unknown";
  }
}

const RERUNNABLE = new Set(["success", "failed", "error", "canceled", "not_run", "unauthorized"]);
const FAILED = new Set(["failed", "error", "canceled"]);
const CANCELLABLE = new Set(["running", "on_hold", "failing"]);

/** The rerun/cancel buttons that apply to a workflow in `status`. */
export function workflowActions(id: string, status: string): Record<string, ActionNode | string> {
  return {
    rerun: RERUNNABLE.has(status) ? action("Rerun", `rerun:${id}`, "Workflow rerun started.") : "",
    rerunFailed: FAILED.has(status)
      ? action("Rerun failed", `rerun-failed:${id}`, "Rerun of failed jobs started.")
      : "",
    cancel: CANCELLABLE.has(status)
      ? action("Cancel", `cancel:${id}`, "Workflow cancelled.", "Cancel this workflow?")
      : "",
  };
}

const ESTIMATE_NOTE = (rates: CircleRates) =>
  `Estimated: CircleCI reports credits, not money. Credits are priced at $${rates.pricePerCredit} each (the published price unless you changed it under Edit credentials)${rates.includedCredits > 0 ? `, after ${rates.includedCredits.toLocaleString("en-US")} included credits a month` : ""}. Insights figures are refreshed daily and are not a billing record.`;

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

function renderOrganization(r: ResourceInstance, rates: CircleRates): DetailViewSchema {
  const f = r.fields;
  const summary = parseJson<OrgSummary>(r.resolvedOutputs[DETAIL_KEYS.orgSummary]);
  const sections: SectionNode[] = [
    section("Last 30 days", [
      kv([
        ["Credits used", fmt(f["credits30d"])],
        ["Estimated cost", usd(f["estimatedCost30d"])],
        ["Workflow runs", fmt(f["runs30d"])],
        ["Success rate", f["successRate30d"] === undefined ? "" : `${f["successRate30d"]}%`],
        ["Projects", fmt(f["projectCount"])],
      ]),
      muted(ESTIMATE_NOTE(rates)),
    ]),
    section("Organization", [
      kv([
        ["Name", f["name"]],
        ["Slug", f["slug"], true],
        ["VCS", f["vcsType"]],
        ["Organization ID", f["orgId"], true],
      ]),
    ]),
  ];
  const projects = (summary?.org_project_data ?? [])
    .slice()
    .sort((a, b) => (b.metrics?.total_credits_used ?? 0) - (a.metrics?.total_credits_used ?? 0));
  if (projects.length > 0) {
    sections.push(
      section("Projects by credits (30 days)", [
        {
          kind: "table",
          columns: [
            { key: "project", label: "Project", width: "wide" },
            { key: "credits", label: "Credits" },
            { key: "cost", label: "Estimated cost" },
            { key: "runs", label: "Runs" },
            { key: "success", label: "Success rate" },
            { key: "duration", label: "Total duration" },
          ],
          rows: projects.map<TableRow>((p) => ({
            cells: {
              project: p.project_name,
              credits: fmt(p.metrics?.total_credits_used),
              cost: usd((p.metrics?.total_credits_used ?? 0) * rates.pricePerCredit),
              runs: fmt(p.metrics?.total_runs),
              success: pctText(p.metrics?.success_rate),
              duration: duration(p.metrics?.total_duration_secs),
            },
          })),
        },
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Organization", str(f["vcsType"])),
    status: { kind: "status-dot", status: "healthy", label: "Organization" },
    sections,
    headerActions: openIn(r.resolvedOutputs["url"]),
  };
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

function workflowTable(workflows: WorkflowMetrics[]): SchemaNode {
  return {
    kind: "table",
    columns: [
      { key: "name", label: "Workflow", width: "wide" },
      { key: "runs", label: "Runs" },
      { key: "success", label: "Success rate" },
      { key: "p50", label: "p50" },
      { key: "p95", label: "p95" },
      { key: "credits", label: "Credits" },
      { key: "mttr", label: "Time to recover" },
    ],
    rows: workflows.map<TableRow>((w) => ({
      cells: {
        name: w.name,
        runs: fmt(w.metrics?.total_runs),
        success: pctText(w.metrics?.success_rate),
        p50: duration(w.metrics?.duration_metrics?.median),
        p95: duration(w.metrics?.duration_metrics?.p95),
        credits: fmt(w.metrics?.total_credits_used),
        mttr: duration(w.metrics?.mttr),
      },
    })),
  };
}

function renderProject(r: ResourceInstance, rates: CircleRates): DetailViewSchema {
  const f = r.fields;
  const workflows = parseJson<WorkflowMetrics[]>(r.resolvedOutputs[DETAIL_KEYS.workflows]) ?? [];
  const flaky = parseJson<FlakyTest[]>(r.resolvedOutputs[DETAIL_KEYS.flakyTests]);
  const sections: SectionNode[] = [
    section("Last 30 days", [
      kv([
        ["Credits used", fmt(f["credits30d"])],
        ["Estimated cost", usd(f["estimatedCost30d"])],
        ["Workflow runs", fmt(f["runs30d"])],
        ["Success rate", f["successRate30d"] === undefined ? "" : `${f["successRate30d"]}%`],
        ["Total duration", duration(f["durationSecs30d"])],
      ]),
      muted(ESTIMATE_NOTE(rates)),
    ]),
    section("Project", [
      kv([
        ["Repository", f["vcsUrl"]],
        ["VCS provider", f["vcsProvider"]],
        ["Default branch", f["defaultBranch"]],
        ["Slug", f["slug"], true],
        ["Project ID", f["projectId"], true],
      ]),
    ]),
  ];
  if (workflows.length > 0) {
    sections.push(section("Workflows (30 days, all branches)", [workflowTable(workflows)]));
  }
  if (flaky && flaky.length > 0) {
    sections.push(
      section("Flaky tests", [
        {
          kind: "table",
          columns: [
            { key: "test", label: "Test", width: "wide" },
            { key: "job", label: "Job" },
            { key: "workflow", label: "Workflow" },
            { key: "flaked", label: "Times flaked" },
            { key: "wasted", label: "Time wasted" },
          ],
          rows: flaky.slice(0, 25).map<TableRow>((t) => ({
            cells: {
              test: [t.classname, t["test-name"]].filter(Boolean).join(" "),
              job: str(t["job-name"]),
              workflow: str(t["workflow-name"]),
              flaked: fmt(t["times-flaked"]),
              wasted: duration(
                typeof t["time-wasted"] === "number" ? t["time-wasted"] / 1000 : undefined,
              ),
            },
          })),
        },
      ]),
    );
  } else if (flaky) {
    sections.push(section("Flaky tests", [muted("No flaky tests detected.")]));
  }
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Project", str(f["vcsProvider"])),
    status: {
      kind: "status-dot",
      status:
        typeof f["successRate30d"] === "number"
          ? f["successRate30d"] >= 90
            ? "healthy"
            : f["successRate30d"] >= 70
              ? "degraded"
              : "error"
          : "unknown",
      label:
        typeof f["successRate30d"] === "number" ? `${f["successRate30d"]}% success` : "Project",
    },
    sections,
    headerActions: [
      ...openIn(r.resolvedOutputs["url"]),
      {
        kind: "action",
        label: "Insights",
        variant: "ghost",
        action: {
          type: "open-url",
          url: str(r.resolvedOutputs["url"]).replace("/pipelines/", "/insights/"),
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

function renderWorkflow(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const jobs = parseJson<JobMetrics[]>(r.resolvedOutputs[DETAIL_KEYS.jobs]) ?? [];
  const runs = parseJson<WorkflowRun[]>(r.resolvedOutputs[DETAIL_KEYS.runs]) ?? [];
  const sections: SectionNode[] = [
    section("Last 30 days (all branches)", [
      kv([
        ["Runs", fmt(f["totalRuns"])],
        ["Success rate", f["successRate"] === undefined ? "" : `${f["successRate"]}%`],
        ["Failed runs", fmt(f["failedRuns"])],
        ["Duration p50", duration(f["durationMedianSecs"])],
        ["Duration p95", duration(f["durationP95Secs"])],
        ["Credits used", fmt(f["credits"])],
        ["Mean time to recovery", duration(f["mttrSecs"])],
        ["Runs per day", fmt(f["throughput"], 2)],
        ["Project", f["projectSlug"], true],
      ]),
    ]),
  ];
  if (jobs.length > 0) {
    sections.push(
      section("Jobs", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Job", width: "wide" },
            { key: "runs", label: "Runs" },
            { key: "success", label: "Success rate" },
            { key: "p50", label: "p50" },
            { key: "p95", label: "p95" },
            { key: "credits", label: "Credits" },
          ],
          rows: jobs
            .slice()
            .sort(
              (a, b) => (b.metrics?.total_credits_used ?? 0) - (a.metrics?.total_credits_used ?? 0),
            )
            .map<TableRow>((j) => ({
              cells: {
                name: j.name,
                runs: fmt(j.metrics?.total_runs),
                success: pctText(j.metrics?.success_rate),
                p50: duration(j.metrics?.duration_metrics?.median),
                p95: duration(j.metrics?.duration_metrics?.p95),
                credits: fmt(j.metrics?.total_credits_used),
              },
            })),
        },
      ]),
    );
  }
  if (runs.length > 0) {
    sections.push(
      section("Recent runs", [
        {
          kind: "table",
          columns: [
            { key: "created", label: "Started", width: "wide" },
            { key: "branch", label: "Branch" },
            { key: "status", label: "Status" },
            { key: "duration", label: "Duration" },
            { key: "credits", label: "Credits" },
            { key: "rerun", label: "" },
            { key: "rerunFailed", label: "" },
          ],
          rows: runs.slice(0, 20).map<TableRow>((run) => {
            const actions = workflowActions(run.id, run.status);
            return {
              cells: {
                created: run.created_at,
                branch: str(run.branch),
                status: run.status,
                duration: duration(run.duration),
                credits: fmt(run.credits_used),
                rerun: actions["rerun"] ?? "",
                rerunFailed: actions["rerunFailed"] ?? "",
              },
            };
          }),
        },
      ]),
    );
  }
  const rate = typeof f["successRate"] === "number" ? f["successRate"] : undefined;
  return withMetricsCapability(
    {
      title: r.displayName,
      subtitle: joinSubtitle("Workflow", str(f["projectSlug"])),
      status: {
        kind: "status-dot",
        status:
          rate === undefined
            ? "unknown"
            : rate >= 90
              ? "healthy"
              : rate >= 70
                ? "degraded"
                : "error",
        label: rate === undefined ? "Workflow" : `${rate}% success`,
      },
      sections,
      headerActions: openIn(r.resolvedOutputs["url"]),
    },
    RESOURCE_TYPES,
    r.resourceTypeId,
    DEFAULT_METRICS_WINDOW_MS,
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

function renderPipeline(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const workflows =
    parseJson<PipelineWorkflowDetail[]>(r.resolvedOutputs[DETAIL_KEYS.pipelineWorkflows]) ?? [];
  const sections: SectionNode[] = [
    section("Pipeline", [
      kv([
        ["Project", f["projectSlug"], true],
        ["Number", f["number"]],
        ["State", f["state"]],
        ["Branch", f["branch"]],
        ["Tag", f["tag"]],
        ["Revision", f["revision"], true],
        ["Commit", f["commitSubject"]],
        ["Trigger", f["trigger"]],
        ["Triggered by", f["actor"]],
        ["Created", f["createdAt"]],
        ["Errors", f["errors"]],
      ]),
    ]),
  ];
  if (workflows.length > 0) {
    sections.push(
      section("Workflows", [
        {
          kind: "table",
          columns: [
            { key: "name", label: "Workflow", width: "wide" },
            { key: "status", label: "Status" },
            { key: "duration", label: "Duration" },
            { key: "rerun", label: "" },
            { key: "rerunFailed", label: "" },
            { key: "cancel", label: "" },
          ],
          rows: workflows.map<TableRow>((w) => {
            const start = w.created_at ? Date.parse(w.created_at) : NaN;
            const stop = w.stopped_at ? Date.parse(w.stopped_at) : NaN;
            return {
              cells: {
                name: w.name,
                status: w.status,
                duration:
                  Number.isFinite(start) && Number.isFinite(stop)
                    ? duration((stop - start) / 1000)
                    : "",
                ...workflowActions(w.id, w.status),
              },
            };
          }),
        },
      ]),
    );
    for (const w of workflows) {
      if (!w.jobs || w.jobs.length === 0) continue;
      sections.push(
        section(`Jobs in ${w.name}`, [
          {
            kind: "table",
            columns: [
              { key: "name", label: "Job", width: "wide" },
              { key: "status", label: "Status" },
              { key: "duration", label: "Duration" },
              { key: "approve", label: "" },
            ],
            rows: w.jobs.map<TableRow>((j) => {
              const start = j.started_at ? Date.parse(j.started_at) : NaN;
              const stop = j.stopped_at ? Date.parse(j.stopped_at) : NaN;
              const approvalId = (j as CircleJob & { approval_request_id?: string })
                .approval_request_id;
              return {
                cells: {
                  name: j.name,
                  status: j.status,
                  duration:
                    Number.isFinite(start) && Number.isFinite(stop)
                      ? duration((stop - start) / 1000)
                      : "",
                  approve:
                    j.type === "approval" && j.status === "on_hold" && approvalId
                      ? action(
                          "Approve",
                          `approve:${w.id}:${approvalId}`,
                          "Job approved.",
                          `Approve "${j.name}" and let the workflow continue?`,
                        )
                      : "",
                },
              };
            }),
          },
        ]),
      );
    }
  }
  const overall = workflows.some((w) => runStatus(w.status) === "error")
    ? "error"
    : workflows.some((w) => runStatus(w.status) === "provisioning")
      ? "provisioning"
      : workflows.length > 0 && workflows.every((w) => w.status === "success")
        ? "healthy"
        : runStatus(str(f["state"]));
  return {
    title: r.displayName,
    subtitle: joinSubtitle("Pipeline", str(f["branch"] || f["tag"])),
    status: { kind: "status-dot", status: overall, label: str(f["state"]) || "Pipeline" },
    sections,
    headerActions: openIn(r.resolvedOutputs["url"]),
  };
}

// ---------------------------------------------------------------------------
// Contexts, variables, schedules, triggers, runners
// ---------------------------------------------------------------------------

function renderContext(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const restrictions = parseJson<ContextRestriction[]>(r.resolvedOutputs[DETAIL_KEYS.restrictions]);
  const sections: SectionNode[] = [
    section("Context", [
      kv([
        ["Name", f["name"]],
        ["Variables", fmt(f["variableCount"])],
        ["Created", f["createdAt"]],
        ["Context ID", f["contextId"], true],
      ]),
      muted(
        "CircleCI never returns variable values. Add a variable, or replace one's value with Edit on the variable.",
      ),
    ]),
  ];
  if (restrictions && restrictions.length > 0) {
    sections.push(
      section("Restrictions", [
        {
          kind: "table",
          columns: [
            { key: "type", label: "Type" },
            { key: "value", label: "Restricted to", width: "wide" },
          ],
          rows: restrictions.map<TableRow>((x) => ({
            cells: {
              type: str(x.restriction_type),
              value: str(x.name ?? x.restriction_value),
            },
          })),
        },
      ]),
    );
  } else if (restrictions) {
    sections.push(
      section("Restrictions", [
        muted("No restrictions: every project in the organization can use this context."),
      ]),
    );
  }
  return {
    title: r.displayName,
    subtitle: "Context",
    status: { kind: "status-dot", status: "healthy", label: "Context" },
    sections,
  };
}

function simple(
  r: ResourceInstance,
  subtitle: string,
  items: Array<[string, unknown, boolean?]>,
  extra: SchemaNode[] = [],
  status: ResourceStatus = "healthy",
  statusLabel = subtitle,
  headerActions: ActionNode[] = [],
): DetailViewSchema {
  return {
    title: r.displayName,
    subtitle,
    status: { kind: "status-dot", status, label: statusLabel },
    sections: [section(subtitle, [kv(items), ...extra])],
    ...(headerActions.length > 0 ? { headerActions } : {}),
  };
}

function renderTrigger(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const disabled = f["disabled"] === true;
  return simple(
    r,
    "Trigger",
    [
      ["Source", f["source"]],
      ["Event", f["eventPreset"]],
      ["Cron schedule (UTC)", f["cronExpression"], true],
      ["Checkout ref", f["checkoutRef"]],
      ["Config ref", f["configRef"]],
      ["Pipeline definition", f["pipelineDefinition"]],
      ["Repository", f["repository"]],
      ["Project", f["projectSlug"], true],
    ],
    [],
    disabled ? "info" : "healthy",
    disabled ? "Disabled" : "Enabled",
    [
      disabled
        ? action("Enable", "enable", "Trigger enabled.")
        : action(
            "Disable",
            "disable",
            "Trigger disabled.",
            "Disable this trigger? It stops starting pipelines until enabled again.",
          ),
    ],
  );
}

function renderRunnerClass(r: ResourceInstance): DetailViewSchema {
  const f = r.fields;
  const runners = typeof f["runnerCount"] === "number" ? f["runnerCount"] : undefined;
  const waiting = typeof f["unclaimedTasks"] === "number" ? f["unclaimedTasks"] : 0;
  return simple(
    r,
    "Runner Resource Class",
    [
      ["Resource class", f["name"], true],
      ["Description", f["description"]],
      ["Runners", fmt(runners)],
      ["Tasks waiting", fmt(f["unclaimedTasks"])],
      ["Tasks running", fmt(f["runningTasks"])],
      ["ID", f["resourceClassId"], true],
    ],
    [
      muted(
        "Tasks waiting is the queue: jobs for this resource class that no runner has claimed. Use Get credentials to mint a token for another runner.",
      ),
    ],
    runners === 0 ? (waiting > 0 ? "error" : "info") : waiting > 0 ? "degraded" : "healthy",
    runners === 0 ? "No runners" : waiting > 0 ? `${waiting} waiting` : "Ready",
  );
}

export function renderCircleDetail(r: ResourceInstance, rates: CircleRates): DetailViewSchema {
  const f = r.fields;
  let schema: DetailViewSchema;
  switch (r.resourceTypeId) {
    case "organization":
      schema = renderOrganization(r, rates);
      break;
    case "project":
      schema = renderProject(r, rates);
      break;
    case "workflow":
      return renderWorkflow(r);
    case "pipeline":
      schema = renderPipeline(r);
      break;
    case "context":
      schema = renderContext(r);
      break;
    case "context-variable":
      schema = simple(
        r,
        "Context Variable",
        [
          ["Name", f["name"], true],
          ["Context", f["context"]],
          ["Created", f["createdAt"]],
          ["Updated", f["updatedAt"]],
        ],
        [muted("The value is write-only. Use Edit to replace it.")],
      );
      break;
    case "project-variable":
      schema = simple(
        r,
        "Project Variable",
        [
          ["Name", f["name"], true],
          ["Masked value", f["maskedValue"]],
          ["Project", f["projectSlug"], true],
          ["Created", f["createdAt"]],
        ],
        [muted("CircleCI only returns a masked value. Use Edit to replace it.")],
      );
      break;
    case "schedule":
      schema = simple(r, "Schedule", [
        ["Runs", f["timetable"]],
        ["Branch", f["branch"]],
        ["Parameters", f["parameters"], true],
        ["Description", f["description"]],
        ["Runs as", f["actor"]],
        ["Project", f["projectSlug"], true],
        ["Updated", f["updatedAt"]],
      ]);
      break;
    case "trigger":
      schema = renderTrigger(r);
      break;
    case "runner-resource-class":
      schema = renderRunnerClass(r);
      break;
    case "runner":
      schema = simple(
        r,
        "Runner",
        [
          ["Resource class", f["resourceClass"], true],
          ["Version", f["version"]],
          ["Running a job", f["busy"]],
          ["First connected", f["firstConnected"]],
          ["Last connected", f["lastConnected"]],
        ],
        [],
        f["busy"] === true ? "provisioning" : "healthy",
        f["busy"] === true ? "Busy" : "Idle",
      );
      break;
    default:
      schema = { title: r.displayName, sections: [] };
  }
  return withMetricsCapability(schema, RESOURCE_TYPES, r.resourceTypeId, DEFAULT_METRICS_WINDOW_MS);
}

export function renderCircleSidebar(r: ResourceInstance): SidebarItemSchema {
  const f = r.fields;
  const dot = (status: ResourceStatus) => ({ kind: "status-dot" as const, status });
  switch (r.resourceTypeId) {
    case "pipeline":
      return { id: r.id, label: r.displayName, status: dot(runStatus(str(f["state"]))) };
    case "trigger":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(f["disabled"] === true ? "info" : "healthy"),
      };
    case "runner":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(f["busy"] === true ? "provisioning" : "healthy"),
      };
    case "runner-resource-class":
      return {
        id: r.id,
        label: r.displayName,
        status: dot(
          f["runnerCount"] === 0
            ? "info"
            : Number(f["unclaimedTasks"] ?? 0) > 0
              ? "degraded"
              : "healthy",
        ),
      };
    default:
      return { id: r.id, label: r.displayName };
  }
}
