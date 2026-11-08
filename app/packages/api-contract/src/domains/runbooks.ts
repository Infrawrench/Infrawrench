/**
 * Runbooks: `/api/org/:orgId/runbooks`, the endpoint definitions.
 *
 * Two permission levels, and the split is the point. Reading and performing a
 * runbook takes `resources:read`: the person who can see the infrastructure is
 * the person who will be woken up about it. Editing takes
 * `org:settings:write`: a procedure is an org-wide statement about how
 * something is done, read by strangers under pressure.
 *
 * The write bodies are documented here and checked by hand in the handlers,
 * whose 400s name the field at fault, so those endpoints are served raw.
 */
import { Schema, Struct } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "../schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../http/schemas/common";
import { optionalRequestBody } from "../http/schemas/documented";
import { numericQuery } from "../http/schemas/query";

const RunbookStepKind = Schema.Literals(["manual", "workflow", "link"]).annotate({
  description:
    "What the step does. Three kinds and not a scripting language: a runbook is written by " +
    "whoever is on call for whoever is on call next, and the moment it needs a language it " +
    "stops being written. `workflow` is the escape hatch; anything genuinely automated " +
    "belongs in a workflow, which already has a sandbox, approvals, secrets and a history.",
});

const RunbookRunStatus = Schema.Literals(["running", "completed", "abandoned"]);
export const RUNBOOK_STEP_STATUSES = ["pending", "done", "skipped", "failed"] as const;
export const RunbookStepStatus = Schema.Literals(RUNBOOK_STEP_STATUSES);

const RunbookStep = Schema.Struct({
  id: Schema.String.annotate({
    description:
      "Stable across edits, because a run's per-step records reference it. Reordering or " +
      "retitling keeps the same step; deleting one orphans its history, which is why runs " +
      "keep the title they saw.",
  }),
  kind: RunbookStepKind,
  title: Schema.String,
  body: Schema.String.annotate({ description: "Markdown: the detail nobody remembers at 03:00." }),
  workflowId: Schema.optionalKey(
    Uuid.annotate({ description: "For `workflow` steps: which workflow the button runs." }),
  ),
  url: Schema.optionalKey(
    Schema.String.annotate({ description: "For `link` steps. `https:` only." }),
  ),
}).annotate({ identifier: "RunbookStep" });

export const Runbook = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  steps: Schema.Array(RunbookStep),
  resourceTypeIds: Schema.Array(Schema.String).annotate({
    description:
      "Resource types this runbook is about; empty means it is not scoped to a type. Used to " +
      "answer 'which runbooks apply here', **never** to restrict who may open it; a " +
      "runbook nobody can find is the failure this feature exists to fix.",
  }),
  tagKey: Schema.NullOr(Schema.String).annotate({
    description: "Optional tag narrowing. Matched case-insensitively.",
  }),
  tagValue: Schema.NullOr(Schema.String).annotate({
    description: "Required value of `tagKey`, matched exactly.",
  }),
  enabled: Schema.Boolean.annotate({
    description:
      "Off keeps the row and hides it from the 'what applies here' lookup. Retiring a runbook " +
      "must not cost you the history of the runs performed against it.",
  }),
  createdByUserId: Schema.NullOr(Uuid),
  createdByName: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  runCount: Schema.Int,
  lastRunAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "Runbook" });

export const RunbookList = Schema.Struct({ runbooks: Schema.Array(Runbook) }).annotate({
  identifier: "RunbookList",
});

const RunbookStepInput = Schema.Struct({
  id: Schema.optionalKey(
    Schema.String.annotate({ description: "Omitted for a new step; the server assigns one." }),
  ),
  kind: RunbookStepKind,
  title: Schema.String.check(minLength(1), maxLength(200)),
  body: Schema.optionalKey(Schema.String.check(maxLength(8000))),
  workflowId: Schema.optionalKey(Schema.NullOr(Uuid)),
  url: Schema.optionalKey(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "RunbookStepInput" });

const runbookCreateFields = {
  name: Schema.String.check(minLength(1), maxLength(120)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(2000)))),
  steps: Schema.optionalKey(Schema.Array(RunbookStepInput).check(maxLength(60))),
  resourceTypeIds: Schema.optionalKey(Schema.Array(Schema.String).check(maxLength(40))),
  tagKey: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(128)))),
  tagValue: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(256)))),
  enabled: Schema.optionalKey(Schema.Boolean),
};

const RunbookCreate = Schema.Struct(runbookCreateFields).annotate({ identifier: "RunbookCreate" });

const RunbookUpdate = Schema.Struct(Struct.map(runbookCreateFields, Schema.optionalKey)).annotate({
  identifier: "RunbookUpdate",
});

const RunbookRunStep = Schema.Struct({
  stepId: Schema.String,
  title: Schema.String.annotate({
    description:
      "The step's title **when the run started**. Copied rather than joined: a runbook is " +
      "edited between incidents, and a postmortem showing today's wording against last " +
      "month's run is not stale, it is quietly wrong.",
  }),
  kind: RunbookStepKind,
  status: RunbookStepStatus,
  note: Schema.NullOr(Schema.String).annotate({
    description: "What the responder typed; output, or why it was skipped.",
  }),
  workflowRunId: Schema.NullOr(Uuid).annotate({
    description:
      "The workflow run this step kicked off. Recorded here; the run itself goes through the " +
      "workflow routes with their own permission, approvals and secrets.",
  }),
  actorUserId: Schema.NullOr(Uuid),
  actorName: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(IsoDateTime),
}).annotate({ identifier: "RunbookRunStep" });

export const RunbookRun = Schema.Struct({
  id: Uuid,
  runbookId: Uuid,
  runbookName: Schema.String.annotate({ description: "The runbook's name when the run started." }),
  status: RunbookRunStatus,
  incidentId: Schema.NullOr(Uuid).annotate({
    description:
      "The incident this was performed under. Not a cascading reference: deleting the incident " +
      "must not delete the record that somebody followed the failover procedure at 03:14.",
  }),
  startedByUserId: Schema.NullOr(Uuid),
  startedByName: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  summary: Schema.NullOr(Schema.String),
  steps: Schema.Array(RunbookRunStep),
}).annotate({ identifier: "RunbookRun" });

export const RunbookRunList = Schema.Struct({ runs: Schema.Array(RunbookRun) }).annotate({
  identifier: "RunbookRunList",
});

const RunbookRunStart = Schema.Struct({
  incidentId: Schema.optionalKey(Schema.NullOr(Uuid)),
}).annotate({ identifier: "RunbookRunStart" });

const RunbookStepUpdate = Schema.Struct({
  status: RunbookStepStatus,
  note: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(maxLength(4000))).annotate({
      description: "Omitted leaves the note alone; `null` clears it.",
    }),
  ),
  workflowRunId: Schema.optionalKey(Schema.NullOr(Uuid)),
}).annotate({ identifier: "RunbookStepUpdate" });

const RunbookRunClose = Schema.Struct({
  status: Schema.Literals(["completed", "abandoned"]),
  summary: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(8000)))),
}).annotate({ identifier: "RunbookRunClose" });

/** The most runs one listing may ask for. */
export const MAX_RUNS_LIMIT = 200;

const RunbookParams = { orgId: OrgId, runbookId: Uuid } as const;
const RunParams = { orgId: OrgId, runId: Uuid } as const;

export class RunbooksGroup extends HttpApiGroup.make("runbooks")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: RunbookList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List the organization's runbooks")
      .annotate(
        OpenApi.Description,
        "Every runbook, with how many times each has been run and when it was last used. Reading " +
          "takes `resources:read`: the person who can see the infrastructure is the person who will " +
          "be woken up about it.",
      )
      .annotate(SuccessDescription, "Runbooks, by name"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: RunbookCreate,
      success: Runbook,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Write a runbook")
      .annotate(
        OpenApi.Description,
        "Editing takes `org:settings:write`: a procedure is an org-wide statement about how " +
          "something is done, and it is read by strangers under pressure. Names are unique within " +
          'an organization: two runbooks called "Failover" is how the wrong one gets run.',
      )
      .annotate(SuccessDescription, "The created runbook"),
    HttpApiEndpoint.get("listRuns", "/runs", {
      params: OrgParams,
      query: {
        runbookId: Schema.optionalKey(Uuid),
        incidentId: Schema.optionalKey(Uuid),
        limit: Schema.optionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_RUNS_LIMIT })),
        ),
      },
      success: RunbookRunList,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List runbook runs")
      .annotate(
        OpenApi.Description,
        "Newest first, optionally narrowed to one runbook or one incident.",
      )
      .annotate(SuccessDescription, "Runs, newest first")
      .annotate(
        InvalidRequestMessage,
        `limit must be a whole number between 1 and ${MAX_RUNS_LIMIT}`,
      )
      .annotate(
        OpenApi.Transform,
        numericQuery({ limit: { type: "integer", minimum: 1, maximum: MAX_RUNS_LIMIT } }),
      ),
    HttpApiEndpoint.get("getRun", "/runs/:runId", {
      params: RunParams,
      success: RunbookRun,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Get one runbook run")
      .annotate(SuccessDescription, "The run"),
    // `resources:read`, like starting a run: performing a checklist is not an
    // act of configuration, and requiring an admin to tick a box mid-incident
    // is how a team stops using the checklist.
    HttpApiEndpoint.patch("tickStep", "/runs/:runId/steps/:stepId", {
      params: { ...RunParams, stepId: Schema.String },
      payload: RunbookStepUpdate,
      success: RunbookRun,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Tick a step")
      .annotate(
        OpenApi.Description,
        "One targeted update on one row, so two responders working the same incident can tick " +
          "different steps at the same moment without either losing the other's work.\n\n" +
          "A closed run refuses updates, and reopening is not offered: a run is a record of what " +
          "happened. Start another run to record another attempt.",
      )
      .annotate(SuccessDescription, "The updated run"),
    HttpApiEndpoint.post("closeRun", "/runs/:runId/close", {
      params: RunParams,
      payload: RunbookRunClose,
      success: RunbookRun,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Close a run out")
      .annotate(
        OpenApi.Description,
        "Closing does **not** settle outstanding steps. A run completed with three steps still " +
          "pending is a true and useful record (it says the incident ended before the checklist " +
          "did) and quietly marking them done would erase the one thing a postmortem wants to know.",
      )
      .annotate(SuccessDescription, "The closed run"),
    HttpApiEndpoint.get("get", "/:runbookId", {
      params: RunbookParams,
      success: Runbook,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Get one runbook")
      .annotate(SuccessDescription, "The runbook"),
    // `resources:read`, deliberately: the point of a runbook is that whoever
    // is awake can follow it.
    HttpApiEndpoint.post("startRun", "/:runbookId/runs", {
      params: RunbookParams,
      payload: RunbookRunStart,
      success: RunbookRun,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Start performing a runbook")
      .annotate(
        OpenApi.Description,
        "Copies every step's title and kind into the run, so the record of what somebody was asked " +
          "to do survives the runbook being rewritten next week.\n\n" +
          "Takes `resources:read`, like ticking a step: performing a checklist is not an act of " +
          "configuration, and requiring an admin mid-incident is how a team stops using it. " +
          "Deliberately not deduplicated against a run already in progress; performing the failover " +
          "twice in one incident is a real thing, and refusing the second would mean it goes " +
          "unrecorded rather than not happening.",
      )
      .annotate(SuccessDescription, "The started run")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.patch("update", "/:runbookId", {
      params: RunbookParams,
      payload: RunbookUpdate,
      success: Runbook,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Edit a runbook")
      .annotate(
        OpenApi.Description,
        "Omitted fields are left alone. The result is validated **after** merging, so a patch that " +
          "only changes the steps still has to produce a runbook that is valid as a whole. A step " +
          "sent with its `id` keeps its identity, so a run in progress still matches it.",
      )
      .annotate(SuccessDescription, "The updated runbook"),
    // Takes the run history with it, which is why the section offers
    // "disable" first.
    HttpApiEndpoint.delete("delete", "/:runbookId", {
      params: RunbookParams,
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete a runbook")
      .annotate(
        OpenApi.Description,
        "Takes its run history with it. To retire a procedure without losing the record of the " +
          "runs performed against it, set `enabled` to false instead.",
      )
      .annotate(SuccessDescription, "The runbook was deleted"),
  )
  .prefix("/api/org/:orgId/runbooks")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Runbooks") {}

export class RunbooksApi extends withApiDefaults(HttpApi.make("runbooks").add(RunbooksGroup)) {}
