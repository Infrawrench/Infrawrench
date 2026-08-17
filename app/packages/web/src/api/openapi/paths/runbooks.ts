import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const RunbookStepKind = z.enum(["manual", "workflow", "link"]).openapi({
  description:
    "What the step does. Three kinds and not a scripting language: a runbook is written by " +
    "whoever is on call for whoever is on call next, and the moment it needs a language it " +
    "stops being written. `workflow` is the escape hatch — anything genuinely automated " +
    "belongs in a workflow, which already has a sandbox, approvals, secrets and a history.",
});

const RunbookRunStatus = z.enum(["running", "completed", "abandoned"]);
const RunbookStepStatus = z.enum(["pending", "done", "skipped", "failed"]);

export function registerRunbookPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const RunbookStep = strict({
    id: z
      .string()
      .describe(
        "Stable across edits, because a run's per-step records reference it. Reordering or " +
          "retitling keeps the same step; deleting one orphans its history, which is why runs " +
          "keep the title they saw.",
      ),
    kind: RunbookStepKind,
    title: z.string(),
    body: z.string().describe("Markdown — the detail nobody remembers at 03:00."),
    workflowId: Uuid.optional().describe("For `workflow` steps: which workflow the button runs."),
    url: z.string().optional().describe("For `link` steps. `https:` only."),
  }).openapi("RunbookStep");

  const Runbook = strict({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    steps: z.array(RunbookStep),
    resourceTypeIds: z
      .array(z.string())
      .describe(
        "Resource types this runbook is about; empty means it is not scoped to a type. Used to " +
          "answer 'which runbooks apply here', **never** to restrict who may open it — a " +
          "runbook nobody can find is the failure this feature exists to fix.",
      ),
    tagKey: z.string().nullable().describe("Optional tag narrowing. Matched case-insensitively."),
    tagValue: z.string().nullable().describe("Required value of `tagKey`, matched exactly."),
    enabled: z
      .boolean()
      .describe(
        "Off keeps the row and hides it from the 'what applies here' lookup. Retiring a runbook " +
          "must not cost you the history of the runs performed against it.",
      ),
    createdByUserId: Uuid.nullable(),
    createdByName: z.string().nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    runCount: z.number().int(),
    lastRunAt: IsoDateTime.nullable(),
  }).openapi("Runbook");

  const RunbookList = strict({ runbooks: z.array(Runbook) }).openapi("RunbookList");

  const RunbookStepInput = strict({
    id: z.string().optional().describe("Omitted for a new step; the server assigns one."),
    kind: RunbookStepKind,
    title: z.string().min(1).max(200),
    body: z.string().max(8000).optional(),
    workflowId: Uuid.nullable().optional(),
    url: z.string().nullable().optional(),
  }).openapi("RunbookStepInput");

  const RunbookCreate = strict({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).nullable().optional(),
    steps: z.array(RunbookStepInput).max(60).optional(),
    resourceTypeIds: z.array(z.string()).max(40).optional(),
    tagKey: z.string().max(128).nullable().optional(),
    tagValue: z.string().max(256).nullable().optional(),
    enabled: z.boolean().optional(),
  }).openapi("RunbookCreate");

  const RunbookUpdate = RunbookCreate.partial().openapi("RunbookUpdate");

  const RunbookRunStep = strict({
    stepId: z.string(),
    title: z
      .string()
      .describe(
        "The step's title **when the run started**. Copied rather than joined: a runbook is " +
          "edited between incidents, and a postmortem showing today's wording against last " +
          "month's run is not stale, it is quietly wrong.",
      ),
    kind: RunbookStepKind,
    status: RunbookStepStatus,
    note: z
      .string()
      .nullable()
      .describe("What the responder typed — output, or why it was skipped."),
    workflowRunId: Uuid.nullable().describe(
      "The workflow run this step kicked off. Recorded here; the run itself goes through the " +
        "workflow routes with their own permission, approvals and secrets.",
    ),
    actorUserId: Uuid.nullable(),
    actorName: z.string().nullable(),
    updatedAt: IsoDateTime.nullable(),
  }).openapi("RunbookRunStep");

  const RunbookRun = strict({
    id: Uuid,
    runbookId: Uuid,
    runbookName: z.string().describe("The runbook's name when the run started."),
    status: RunbookRunStatus,
    incidentId: Uuid.nullable().describe(
      "The incident this was performed under. Not a cascading reference: deleting the incident " +
        "must not delete the record that somebody followed the failover procedure at 03:14.",
    ),
    startedByUserId: Uuid.nullable(),
    startedByName: z.string().nullable(),
    startedAt: IsoDateTime,
    completedAt: IsoDateTime.nullable(),
    summary: z.string().nullable(),
    steps: z.array(RunbookRunStep),
  }).openapi("RunbookRun");

  const RunbookRunList = strict({ runs: z.array(RunbookRun) }).openapi("RunbookRunList");

  const RunbookRunStart = strict({
    incidentId: Uuid.nullable().optional(),
  }).openapi("RunbookRunStart");

  const RunbookStepUpdate = strict({
    status: RunbookStepStatus,
    note: z
      .string()
      .max(4000)
      .nullable()
      .optional()
      .describe("Omitted leaves the note alone; `null` clears it."),
    workflowRunId: Uuid.nullable().optional(),
  }).openapi("RunbookStepUpdate");

  const RunbookRunClose = strict({
    status: z.enum(["completed", "abandoned"]),
    summary: z.string().max(8000).nullable().optional(),
  }).openapi("RunbookRunClose");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/runbooks",
    tags: ["Runbooks"],
    summary: "List the organization's runbooks",
    description:
      "Every runbook, with how many times each has been run and when it was last used. Reading " +
      "takes `resources:read`: the person who can see the infrastructure is the person who will " +
      "be woken up about it.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Runbooks, by name",
        content: { "application/json": { schema: RunbookList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/runbooks",
    tags: ["Runbooks"],
    summary: "Write a runbook",
    description:
      "Editing takes `org:settings:write` — a procedure is an org-wide statement about how " +
      "something is done, and it is read by strangers under pressure. Names are unique within " +
      'an organization: two runbooks called "Failover" is how the wrong one gets run.',
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: RunbookCreate } } },
    },
    responses: {
      200: {
        description: "The created runbook",
        content: { "application/json": { schema: Runbook } },
      },
      400: ErrorResponses[400],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/runbooks/{runbookId}",
    tags: ["Runbooks"],
    summary: "Get one runbook",
    request: { params: OrgIdParam.extend({ runbookId: Uuid }) },
    responses: {
      200: { description: "The runbook", content: { "application/json": { schema: Runbook } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/runbooks/{runbookId}",
    tags: ["Runbooks"],
    summary: "Edit a runbook",
    description:
      "Omitted fields are left alone. The result is validated **after** merging, so a patch that " +
      "only changes the steps still has to produce a runbook that is valid as a whole. A step " +
      "sent with its `id` keeps its identity, so a run in progress still matches it.",
    request: {
      params: OrgIdParam.extend({ runbookId: Uuid }),
      body: { content: { "application/json": { schema: RunbookUpdate } } },
    },
    responses: {
      200: {
        description: "The updated runbook",
        content: { "application/json": { schema: Runbook } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/runbooks/{runbookId}",
    tags: ["Runbooks"],
    summary: "Delete a runbook",
    description:
      "Takes its run history with it. To retire a procedure without losing the record of the " +
      "runs performed against it, set `enabled` to false instead.",
    request: { params: OrgIdParam.extend({ runbookId: Uuid }) },
    responses: { 204: { description: "The runbook was deleted" }, 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/runbooks/{runbookId}/runs",
    tags: ["Runbooks"],
    summary: "Start performing a runbook",
    description:
      "Copies every step's title and kind into the run, so the record of what somebody was asked " +
      "to do survives the runbook being rewritten next week.\n\n" +
      "Takes `resources:read`, like ticking a step: performing a checklist is not an act of " +
      "configuration, and requiring an admin mid-incident is how a team stops using it. " +
      "Deliberately not deduplicated against a run already in progress — performing the failover " +
      "twice in one incident is a real thing, and refusing the second would mean it goes " +
      "unrecorded rather than not happening.",
    request: {
      params: OrgIdParam.extend({ runbookId: Uuid }),
      body: { content: { "application/json": { schema: RunbookRunStart } } },
    },
    responses: {
      200: {
        description: "The started run",
        content: { "application/json": { schema: RunbookRun } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/runbooks/runs",
    tags: ["Runbooks"],
    summary: "List runbook runs",
    description: "Newest first, optionally narrowed to one runbook or one incident.",
    request: {
      params: OrgIdParam,
      query: z.object({
        runbookId: Uuid.optional(),
        incidentId: Uuid.optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: {
        description: "Runs, newest first",
        content: { "application/json": { schema: RunbookRunList } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/runbooks/runs/{runId}",
    tags: ["Runbooks"],
    summary: "Get one runbook run",
    request: { params: OrgIdParam.extend({ runId: Uuid }) },
    responses: {
      200: { description: "The run", content: { "application/json": { schema: RunbookRun } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/runbooks/runs/{runId}/steps/{stepId}",
    tags: ["Runbooks"],
    summary: "Tick a step",
    description:
      "One targeted update on one row, so two responders working the same incident can tick " +
      "different steps at the same moment without either losing the other's work.\n\n" +
      "A closed run refuses updates, and reopening is not offered: a run is a record of what " +
      "happened. Start another run to record another attempt.",
    request: {
      params: OrgIdParam.extend({ runId: Uuid, stepId: z.string() }),
      body: { content: { "application/json": { schema: RunbookStepUpdate } } },
    },
    responses: {
      200: {
        description: "The updated run",
        content: { "application/json": { schema: RunbookRun } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/runbooks/runs/{runId}/close",
    tags: ["Runbooks"],
    summary: "Close a run out",
    description:
      "Closing does **not** settle outstanding steps. A run completed with three steps still " +
      "pending is a true and useful record — it says the incident ended before the checklist " +
      "did — and quietly marking them done would erase the one thing a postmortem wants to know.",
    request: {
      params: OrgIdParam.extend({ runId: Uuid }),
      body: { content: { "application/json": { schema: RunbookRunClose } } },
    },
    responses: {
      200: {
        description: "The closed run",
        content: { "application/json": { schema: RunbookRun } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });
}
