import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

/**
 * Workflow cron-schedule endpoints. The full workflow CRUD surface (source,
 * runs, typings, metrics) is not yet in the published spec — registering it is
 * a follow-up; the schedule sub-resource is documented first because it is the
 * piece programmatic clients automate (create a workflow in the UI, then have
 * CI or an SDK manage when it runs).
 */

const CronExpression = z
  .string()
  .min(1)
  .max(200)
  .openapi({
    description:
      "Standard 5-field cron expression (minute hour day-of-month month day-of-week). " +
      "Supports `*`, lists, ranges, and steps; 3-letter month/weekday names; `7` as Sunday. " +
      "When both day fields are restricted, a date matches if either does (POSIX).",
    example: "0 9 * * 1",
  });

const CronTimezone = z.string().min(1).max(100).openapi({
  description: "IANA timezone the expression's wall times are evaluated in. Omit or null for UTC.",
  example: "Europe/London",
});

const WorkflowSchedule = strict({
  expression: CronExpression,
  timezone: CronTimezone.nullable(),
  enabled: z.boolean().openapi({
    description:
      "Mirrors the workflow's enabled flag — a disabled workflow's schedule never fires.",
  }),
  lastRunAt: IsoDateTime.nullable().openapi({
    description: "When the workflow last finished a run (any trigger source).",
  }),
  nextRunAt: IsoDateTime.nullable().openapi({
    description:
      "The persisted next fire time the scheduler will claim. Null while disabled, or when the expression never matches.",
  }),
  nextRuns: z.array(IsoDateTime).openapi({
    description: "Preview of the next few fire times, computed at read time.",
  }),
}).openapi("WorkflowSchedule");

const WorkflowScheduleResponse = strict({
  schedule: z.union([WorkflowSchedule, z.null()]).openapi({
    description: "Null when the workflow's trigger is not cron.",
  }),
}).openapi("WorkflowScheduleResponse");

const WorkflowScheduleInput = strict({
  expression: CronExpression,
  timezone: CronTimezone.nullable().optional(),
  enabled: z.boolean().optional().openapi({
    description: "Also set the workflow's enabled flag. Omit to leave it unchanged.",
  }),
}).openapi("WorkflowScheduleInput");

export function registerWorkflowPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParam = () =>
    OrgIdParam.extend({
      id: Uuid.openapi({ param: { name: "id", in: "path" }, description: "Workflow id" }),
    });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/workflows/{id}/schedule",
    tags: ["Workflows"],
    summary: "Get a workflow's cron schedule",
    description:
      "The schedule view of the workflow's trigger, with the next few computed fire times. `schedule` is null when the workflow is triggered some other way (manual, git, budget).",
    request: { params: idParam() },
    responses: {
      200: {
        description: "Schedule (or null when the trigger is not cron)",
        content: { "application/json": { schema: WorkflowScheduleResponse } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/workflows/{id}/schedule",
    tags: ["Workflows"],
    summary: "Create or replace a workflow's cron schedule",
    description:
      "Sets the workflow's trigger to cron with the given expression and timezone, validating both, and computes the next fire time. The workflow fires at the schedule's next occurrence — never immediately on save.",
    request: {
      params: idParam(),
      body: {
        content: { "application/json": { schema: WorkflowScheduleInput } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "The stored schedule",
        content: { "application/json": { schema: WorkflowScheduleResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/workflows/{id}/schedule",
    tags: ["Workflows"],
    summary: "Remove a workflow's cron schedule",
    description:
      "Reverts the workflow's trigger to manual and clears the pending fire time. A no-op when the trigger is not cron.",
    request: { params: idParam() },
    responses: {
      200: { description: "Removed", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });
}
