/**
 * Workflows: `/api/org/:orgId/workflows`, the endpoint definitions.
 *
 * The whole surface is documented: CRUD, a manual run, its run history and
 * metric values, a headless type check, the schedule, typings and secret
 * assignments. A workflow is answered as its stored row, every column but the
 * webhook signing secret, which is write-only (`hasWebhookSecret` says whether
 * one is set).
 *
 * Reads take `workflows:read`; creating, editing, deleting and manually
 * running take `workflows:write`. Bodies are read raw by the handlers, which
 * answer a malformed field with their own sentence, so the declared payloads
 * describe what clients send rather than decoding it.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden, NotFound, Unauthorized } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { documentedAs } from "../http/schemas/documented";
import { IsoDateTime, Ok, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { WorkflowSecret } from "../http/schemas/workflow-secrets";

const WorkflowParams = {
  orgId: OrgId,
  id: Uuid.annotate({ description: "Workflow id" }),
} as const;

const CronExpression = Schema.String.check(minLength(1), maxLength(200)).annotate({
  description:
    "Standard 5-field cron expression (minute hour day-of-month month day-of-week). " +
    "Supports `*`, lists, ranges, and steps; 3-letter month/weekday names; `7` as Sunday. " +
    "When both day fields are restricted, a date matches if either does (POSIX).",
  examples: ["0 9 * * 1"],
});

const CronTimezone = Schema.NullOr(Schema.String.check(minLength(1), maxLength(100))).annotate({
  description: "IANA timezone the expression's wall times are evaluated in. Omit or null for UTC.",
  examples: ["Europe/London"],
});

const WorkflowSchedule = Schema.Struct({
  expression: CronExpression,
  timezone: CronTimezone,
  enabled: Schema.Boolean.annotate({
    description: "Mirrors the workflow's enabled flag; a disabled workflow's schedule never fires.",
  }),
  lastRunAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the workflow last finished a run (any trigger source).",
  }),
  nextRunAt: Schema.NullOr(IsoDateTime).annotate({
    description:
      "The persisted next fire time the scheduler will claim. Null while disabled, or when the expression never matches.",
  }),
  nextRuns: Schema.Array(IsoDateTime).annotate({
    description: "Preview of the next few fire times, computed at read time.",
  }),
}).annotate({ identifier: "WorkflowSchedule" });

export const WorkflowScheduleResponse = Schema.Struct({
  schedule: Schema.NullOr(WorkflowSchedule).annotate({
    description: "Null when the workflow's trigger is not cron.",
  }),
}).annotate({ identifier: "WorkflowScheduleResponse" });

const WorkflowScheduleInput = Schema.Struct({
  expression: CronExpression,
  timezone: Schema.optionalKey(CronTimezone),
  enabled: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Also set the workflow's enabled flag. Omit to leave it unchanged.",
    }),
  ),
}).annotate({ identifier: "WorkflowScheduleInput" });

export const WorkflowTypingsResponse = Schema.Struct({
  dts: Schema.String.annotate({
    description:
      "Ambient TypeScript declarations for this workflow's `infra` API; the same " +
      "file the Monaco editor and `check` endpoint type against.",
  }),
}).annotate({ identifier: "WorkflowTypingsResponse" });

export const WorkflowSecretAssignment = Schema.Struct({
  secretIds: Schema.Array(Uuid),
  secrets: Schema.Array(WorkflowSecret),
}).annotate({ identifier: "WorkflowSecretAssignment" });

const WorkflowSecretAssignmentInput = Schema.Struct({
  secretIds: Schema.Array(Uuid),
}).annotate({ identifier: "WorkflowSecretAssignmentInput" });

/** What starts a workflow: stored as sent, after the cron and budget fields are normalised. */
const WorkflowTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual") }),
  Schema.Struct({
    kind: Schema.Literal("cron"),
    expression: Schema.String.annotate({ description: "5-field cron expression." }),
    timezone: Schema.optionalKey(
      Schema.String.annotate({ description: "IANA timezone; omitted for UTC." }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("git"),
    provider: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "Informational (`github`, `gitlab`, `generic`); deliveries are matched by token.",
      }),
    ),
    repo: Schema.optionalKey(Schema.String.annotate({ examples: ["acme/infra"] })),
    branch: Schema.optionalKey(
      Schema.String.annotate({ description: "Only run when the push targets this branch." }),
    ),
    events: Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        description: "Which webhook events trigger a run. Omitted: `push`.",
      }),
    ),
    installationId: Schema.optionalKey(
      Schema.Int.annotate({
        description: "The organization's GitHub App installation that authorizes watching `repo`.",
      }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("budget"),
    budgetId: Uuid.annotate({ description: "The budget this workflow watches." }),
    percent: Schema.optionalKey(
      Schema.Finite.annotate({
        description:
          "Fire when the measure reaches this percentage of the budget. Stored as 100 when omitted.",
      }),
    ),
    metric: Schema.optionalKey(
      Schema.Literals(["actual", "forecast"]).annotate({
        description:
          "Month-to-date spend, or the projected month-end total. Stored as `actual` when omitted.",
      }),
    ),
  }),
]).annotate({ identifier: "WorkflowTrigger" });

/** A metric the workflow declares; surfaced in its typings as `infra.metrics.<key>`. */
const WorkflowMetricDef = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  type: Schema.Literals(["number", "string", "boolean"]),
  unit: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "WorkflowMetricDef" });

export const Workflow = Schema.Struct({
  id: Uuid,
  organizationId: OrgId,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  source: Schema.String.annotate({ description: "The workflow's TypeScript source." }),
  trigger: WorkflowTrigger,
  metricDefs: Schema.Array(WorkflowMetricDef),
  enabled: Schema.Boolean,
  webhookToken: Schema.NullOr(Schema.String).annotate({
    description: "The token in a git trigger's webhook URL; null for other triggers.",
  }),
  hasWebhookSecret: Schema.Boolean.annotate({
    description:
      "Whether a git webhook signing secret is set. The secret itself is never returned.",
  }),
  gitLastSha: Schema.NullOr(Schema.String).annotate({
    description: "The last commit a git trigger's repository watcher saw.",
  }),
  budgetLastFiredKey: Schema.NullOr(Schema.String).annotate({
    description:
      "The budget crossing that last fired a budget trigger, so each fires once a period.",
  }),
  nextRunAt: Schema.NullOr(IsoDateTime).annotate({
    description: "The next fire time of a cron trigger.",
  }),
  lastRunAt: Schema.NullOr(IsoDateTime),
  createdByUserId: Schema.NullOr(Schema.String),
  sourceAuthorUserId: Schema.NullOr(Schema.String).annotate({
    description:
      "Who automated runs act for: the user who last changed the source, trigger or assigned secrets.",
  }),
  syncVersion: Schema.Int,
  deletedAt: Schema.NullOr(IsoDateTime).annotate({
    description: "Always null: deleted workflows are not listed.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "Workflow" });

const WorkflowInput = Schema.Struct({
  name: Schema.optionalKey(
    Schema.String.annotate({
      description: "Trimmed. Omitted or blank: `Untitled workflow` on create, unchanged on update.",
    }),
  ),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  source: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(WorkflowTrigger),
  metrics: Schema.optionalKey(Schema.Array(WorkflowMetricDef)),
  enabled: Schema.optionalKey(Schema.Boolean),
  secretIds: Schema.optionalKey(
    Schema.Array(Uuid).annotate({
      description:
        "Replaces the organization secrets assigned to the workflow. Needs `secrets:read`.",
    }),
  ),
  webhookSecret: Schema.optionalKey(
    Schema.NullOr(Schema.String).annotate({
      description:
        "Sets or rotates the git webhook signing secret; null or empty clears it. Write-only.",
    }),
  ),
}).annotate({ identifier: "WorkflowInput" });

const WorkflowRunLog = Schema.Struct({
  at: Schema.Finite.annotate({ description: "Milliseconds since the epoch." }),
  level: Schema.Literals(["debug", "info", "warn", "error"]),
  message: Schema.String,
}).annotate({ identifier: "WorkflowRunLog" });

const WorkflowRunError = Schema.Struct({
  message: Schema.String,
  stack: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "WorkflowRunError" });

const WorkflowRunStatus = Schema.Literals(["pending", "running", "success", "failure", "canceled"]);

/** A finished run's outcome, as the sandbox reports it (epoch-millisecond timestamps). */
const WorkflowRunResult = Schema.Struct({
  status: WorkflowRunStatus,
  logs: Schema.Array(WorkflowRunLog),
  output: Schema.optionalKey(
    Schema.Unknown.annotate({
      description: "What the workflow returned, or passed to `infra.output`.",
    }),
  ),
  error: Schema.optionalKey(WorkflowRunError),
  startedAt: Schema.Finite,
  finishedAt: Schema.Finite,
  durationMs: Schema.Finite,
}).annotate({ identifier: "WorkflowRunResult" });

export const WorkflowRunOutcome = Schema.Struct({
  runId: Uuid,
  result: WorkflowRunResult,
}).annotate({ identifier: "WorkflowRunOutcome" });

/** A stored run (ISO timestamps). */
const WorkflowRun = Schema.Struct({
  id: Uuid,
  organizationId: OrgId,
  workflowId: Uuid,
  status: WorkflowRunStatus,
  triggerSource: Schema.String.annotate({
    description: "`manual`, `cron`, `git`, `api` or `budget`.",
  }),
  logs: Schema.Array(WorkflowRunLog),
  output: Schema.Unknown.annotate({ description: "What the run returned; null when nothing." }),
  error: Schema.NullOr(WorkflowRunError),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  durationMs: Schema.NullOr(Schema.Int),
  syncVersion: Schema.Int,
  createdAt: IsoDateTime,
}).annotate({ identifier: "WorkflowRun" });

export const WorkflowRunList = Schema.Array(WorkflowRun).annotate({
  description: "The workflow's last 50 runs, newest first.",
});

/** A declared metric's current value. */
const WorkflowMetric = Schema.Struct({
  id: Uuid,
  organizationId: OrgId,
  workflowId: Uuid,
  key: Schema.String,
  label: Schema.String,
  type: Schema.String.annotate({ description: "`number`, `string` or `boolean`." }),
  unit: Schema.NullOr(Schema.String),
  value: Schema.Unknown.annotate({
    description: "The current value (a number, string or boolean), or null before the first write.",
  }),
  syncVersion: Schema.Int,
  deletedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
}).annotate({ identifier: "WorkflowMetric" });

export const WorkflowMetricList = Schema.Array(WorkflowMetric);

export const WorkflowList = Schema.Array(Workflow).annotate({
  description: "The organization's workflows, most recently updated first.",
});

const WorkflowCheckInput = Schema.Struct({
  source: Schema.optionalKey(
    Schema.String.annotate({ description: "The source to check. Omitted: the stored source." }),
  ),
}).annotate({ identifier: "WorkflowCheckInput" });

export const WorkflowTypecheckResult = Schema.Struct({
  diagnostics: Schema.Array(
    Schema.Struct({
      line: Schema.Int.annotate({ description: "1-based; 0 when unknown." }),
      column: Schema.Int.annotate({ description: "1-based; 0 when unknown." }),
      code: Schema.Int.annotate({ description: "TypeScript diagnostic code.", examples: [2339] }),
      category: Schema.Literals(["error", "warning", "suggestion", "message"]),
      message: Schema.String,
    }).annotate({ identifier: "WorkflowDiagnostic" }),
  ),
  hasErrors: Schema.Boolean,
  degraded: Schema.Boolean.annotate({
    description:
      "True when only syntax could be checked (the TypeScript standard library was missing).",
  }),
}).annotate({ identifier: "WorkflowTypecheckResult" });

export class WorkflowsGroup extends HttpApiGroup.make("workflows")
  .add(
    HttpApiEndpoint.get("list", "/", { params: OrgParams, success: WorkflowList })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Summary, "List workflows")
      .annotate(SuccessDescription, "Workflows"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: WorkflowInput,
      success: Workflow.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "workflows:write")
      .annotate(OpenApi.Summary, "Create a workflow")
      .annotate(
        OpenApi.Description,
        "Every field is optional: an empty body creates an enabled, manually triggered workflow with no source. Assigning secrets (`secretIds`) also needs `secrets:read`.",
      )
      .annotate(SuccessDescription, "Created"),
    HttpApiEndpoint.get("get", "/:id", {
      params: WorkflowParams,
      success: Workflow,
      error: NotFound,
    })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Summary, "Get a workflow")
      .annotate(SuccessDescription, "Workflow"),
    HttpApiEndpoint.put("update", "/:id", {
      params: WorkflowParams,
      payload: WorkflowInput,
      success: Workflow,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "workflows:write")
      .annotate(OpenApi.Summary, "Update a workflow")
      .annotate(
        OpenApi.Description,
        "An omitted field keeps its stored value. Changing the source, trigger or assigned secrets makes automated runs act with the caller's permissions from then on; when the workflow has secrets assigned, any edit also needs `secrets:read`.",
      )
      .annotate(SuccessDescription, "Updated"),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: WorkflowParams,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "workflows:write")
      .annotate(OpenApi.Summary, "Delete a workflow")
      .annotate(SuccessDescription, "Deleted"),
    // Reusable organization secrets explicitly made available to this workflow.
    HttpApiEndpoint.get("getSecrets", "/:id/secrets", {
      params: WorkflowParams,
      success: WorkflowSecretAssignment,
      error: NotFound,
    })
      .annotate(RequiredPermission, "secrets:read")
      .annotate(OpenApi.Summary, "List a workflow's assigned secrets")
      .annotate(OpenApi.Description, "Returns assigned ids and metadata only, never values.")
      .annotate(SuccessDescription, "Assigned secret metadata"),
    // `workflows:write` to change the workflow, plus `secrets:read` (checked in
    // the handler) to choose which secrets its runs load.
    HttpApiEndpoint.put("setSecrets", "/:id/secrets", {
      params: WorkflowParams,
      payload: WorkflowSecretAssignmentInput,
      success: WorkflowSecretAssignment,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "workflows:write")
      .annotate(OpenApi.Summary, "Replace a workflow's secret assignments")
      .annotate(SuccessDescription, "Assigned secret metadata"),
    // The schedule is what turns a workflow into an automation that runs
    // unattended, so setting one is a workflow edit, not dashboard content.
    HttpApiEndpoint.get("getSchedule", "/:id/schedule", {
      params: WorkflowParams,
      success: WorkflowScheduleResponse,
      error: NotFound,
    })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Summary, "Get a workflow's cron schedule")
      .annotate(
        OpenApi.Description,
        "The schedule view of the workflow's trigger, with the next few computed fire times. `schedule` is null when the workflow is triggered some other way (manual, git, budget).",
      )
      .annotate(SuccessDescription, "Schedule (or null when the trigger is not cron)"),
    HttpApiEndpoint.put("setSchedule", "/:id/schedule", {
      params: WorkflowParams,
      payload: WorkflowScheduleInput,
      success: WorkflowScheduleResponse,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "workflows:write")
      .annotate(OpenApi.Summary, "Create or replace a workflow's cron schedule")
      .annotate(
        OpenApi.Description,
        "Sets the workflow's trigger to cron with the given expression and timezone, validating both, and computes the next fire time. The workflow fires at the schedule's next occurrence; never immediately on save.\n\nChanging the schedule makes scheduled runs act with the permissions of the caller from then on, the same as editing the workflow's code. When the workflow has secrets assigned, the caller also needs `secrets:read`.",
      )
      .annotate(SuccessDescription, "The stored schedule"),
    HttpApiEndpoint.delete("clearSchedule", "/:id/schedule", {
      params: WorkflowParams,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "workflows:write")
      .annotate(OpenApi.Summary, "Remove a workflow's cron schedule")
      .annotate(
        OpenApi.Description,
        "Reverts the workflow's trigger to manual and clears the pending fire time. A no-op when the trigger is not cron.",
      )
      .annotate(SuccessDescription, "Removed"),
    // Default = static plugin defs + account names (fast). `?enrich=1` hits
    // providers for precise create() field unions: the editor loads static
    // first and upgrades in a second pass. `secrets:read` in the handler.
    HttpApiEndpoint.get("typings", "/:id/typings", {
      params: WorkflowParams,
      query: {
        // Read as sent: anything but `1` or `true` is the static surface.
        enrich: Schema.optionalKey(
          documentedAs(
            Schema.Literals(["1", "true"]).annotate({
              description:
                "When `1` or `true`, enrich create() field shapes and sidecar capabilities from " +
                "live provider configs. Omit for the fast static surface.",
            }),
          ),
        ),
      },
      success: WorkflowTypingsResponse,
      error: [Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Summary, "Generated infra.d.ts for a workflow")
      .annotate(
        OpenApi.Description,
        "The ambient TypeScript declarations workflow source is written against, specialized " +
          "with this organization's connected accounts, resource types, SSH key names, and the " +
          "workflow's trigger + metrics. Default is the fast static surface (`create` fields are " +
          "`Record<string, string>`). Pass `enrich=1` for a second pass that hits provider APIs for " +
          "precise create() field unions and live sidecar capability flags; the editor loads " +
          "static first and upgrades when that finishes.",
      )
      .annotate(SuccessDescription, "Generated declarations"),
    // Headless type check of a candidate source (editorless clients).
    HttpApiEndpoint.post("check", "/:id/check", {
      params: WorkflowParams,
      payload: WorkflowCheckInput,
      success: WorkflowTypecheckResult,
      error: [Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Summary, "Type-check workflow source")
      .annotate(
        OpenApi.Description,
        "Checks `source` (or the stored source) against the workflow's generated typings, the same check the editor runs. Needs `secrets:read` as well, since the typings name the assigned secrets.",
      )
      .annotate(SuccessDescription, "Diagnostics"),
    // Non-interactive: an interactive or debug run goes over the websocket.
    HttpApiEndpoint.post("run", "/:id/run", {
      params: WorkflowParams,
      success: WorkflowRunOutcome,
      error: [NotFound, Unauthorized],
    })
      .annotate(RequiredPermission, "workflows:write")
      .annotate(OpenApi.Summary, "Run a workflow now")
      .annotate(
        OpenApi.Description,
        "Runs the workflow to completion with the caller's permissions and answers its outcome. Non-interactive: an `infra.prompt` gets no answer.",
      )
      .annotate(SuccessDescription, "The finished run"),
    HttpApiEndpoint.get("runs", "/:id/runs", {
      params: WorkflowParams,
      success: WorkflowRunList,
      error: NotFound,
    })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Summary, "A workflow's recent runs")
      .annotate(SuccessDescription, "Runs"),
    HttpApiEndpoint.get("metrics", "/:id/metrics", {
      params: WorkflowParams,
      success: WorkflowMetricList,
      error: NotFound,
    })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Summary, "A workflow's metric values")
      .annotate(SuccessDescription, "Metrics"),
  )
  .prefix("/api/org/:orgId/workflows")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Workflows") {}

export class WorkflowsApi extends withApiDefaults(HttpApi.make("workflows").add(WorkflowsGroup)) {}
