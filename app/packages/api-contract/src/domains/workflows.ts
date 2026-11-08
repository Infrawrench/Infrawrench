/**
 * Workflows: `/api/org/:orgId/workflows`, the endpoint definitions.
 *
 * Only the schedule, typings and secret-assignment sub-resources are in the
 * published spec (what CI, SDKs and editors automate). The rest of the CRUD
 * surface (source, runs, metrics, check, run) is served here too but stays
 * out of the document, as it always has: `OpenApi.Exclude`, with the same
 * permission gates.
 *
 * Reads take `workflows:read`; creating, editing, deleting and manually
 * running take `workflows:write`. Bodies are read raw by the handlers, which
 * answer a malformed field with their own sentence.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Forbidden, NotFound, Unauthorized } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { documentedAs } from "../http/schemas/documented";
import { IsoDateTime, Ok, OrgId, OrgParams, Undocumented, Uuid } from "../http/schemas/common";
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

export class WorkflowsGroup extends HttpApiGroup.make("workflows")
  .add(
    HttpApiEndpoint.get("list", "/", { params: OrgParams, success: Undocumented })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: Undocumented,
      success: Undocumented.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "workflows:write")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.get("get", "/:id", {
      params: WorkflowParams,
      success: Undocumented,
      error: NotFound,
    })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.put("update", "/:id", {
      params: WorkflowParams,
      payload: Undocumented,
      success: Undocumented,
      error: [BadRequest, Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "workflows:write")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: WorkflowParams,
      success: Ok,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "workflows:write")
      .annotate(OpenApi.Exclude, true),
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
      payload: Undocumented,
      success: Undocumented,
      error: [Forbidden, NotFound],
    })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.post("run", "/:id/run", {
      params: WorkflowParams,
      success: Undocumented,
      error: [NotFound, Unauthorized],
    })
      .annotate(RequiredPermission, "workflows:write")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.get("runs", "/:id/runs", {
      params: WorkflowParams,
      success: Undocumented,
      error: NotFound,
    })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Exclude, true),
    HttpApiEndpoint.get("metrics", "/:id/metrics", {
      params: WorkflowParams,
      success: Undocumented,
      error: NotFound,
    })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Exclude, true),
  )
  .prefix("/api/org/:orgId/workflows")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Workflows") {}

export class WorkflowsApi extends withApiDefaults(HttpApi.make("workflows").add(WorkflowsGroup)) {}
