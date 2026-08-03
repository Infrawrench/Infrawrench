import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const ScheduleAction = z.enum(["stop", "start"]).openapi({
  description: "A schedule transition: `stop` powers the resource off, `start` powers it on.",
});

const ScheduleRunStatus = z.enum(["ok", "failed", "skipped_freeze"]).openapi({
  description:
    "Outcome of the last executed transition: `ok`, `failed` (see `lastRunError`), or " +
    "`skipped_freeze` (an org change freeze was in effect, so the transition was skipped).",
});

const DaysOfWeek = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .max(7)
  .openapi({
    description: "ISO weekdays the resource is worked on: 1 = Monday … 7 = Sunday.",
    example: [1, 2, 3, 4, 5],
  });

const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .openapi({
    description: 'Wall-clock time of day, 24-hour `"HH:MM"`, in the schedule\'s timezone.',
    example: "19:00",
  });

const TimeZone = z.string().openapi({
  description: "IANA timezone the wall-clock times are computed in (DST-safe).",
  example: "Europe/London",
});

export function registerSchedulePaths(ctx: BuildContext) {
  const { registry, enums } = ctx;

  const SleepSchedule = strict({
    id: Uuid,
    resourceId: z.string().describe("Infrawrench resource id the schedule powers on and off."),
    accountId: Uuid,
    pluginId: enums.PluginId,
    resourceTypeId: z.string(),
    resourceName: z.string().describe("Resource display name at read time."),
    accountName: z.string(),
    daysOfWeek: DaysOfWeek,
    stopTime: TimeOfDay.describe("When the resource is stopped on each selected day."),
    startTime: TimeOfDay.describe("When the resource is started on each selected day."),
    timezone: TimeZone,
    paused: z.boolean().describe("Paused schedules keep their timing but never fire."),
    nextTransitionAt: IsoDateTime.nullable().describe("Next due transition; null while paused."),
    nextTransitionAction: ScheduleAction.nullable(),
    lastRunAt: IsoDateTime.nullable(),
    lastRunAction: ScheduleAction.nullable(),
    lastRunStatus: ScheduleRunStatus.nullable(),
    lastRunError: z.string().nullable().describe("Failure detail for a failed run."),
    projectedMonthlySaving: z
      .number()
      .nullable()
      .describe(
        "Projected monthly saving from trailing per-resource spend × the weekly off-hours " +
          "fraction; null when billing holds no rows for the resource.",
      ),
    currency: z.string().nullable().describe("Currency of the projection, when present."),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("SleepSchedule");

  const SleepScheduleList = strict({
    schedules: z.array(SleepSchedule),
  }).openapi("SleepScheduleList");

  const SleepScheduleCreate = strict({
    resourceId: z.string(),
    accountId: Uuid,
    daysOfWeek: DaysOfWeek,
    stopTime: TimeOfDay,
    startTime: TimeOfDay,
    timezone: TimeZone,
  }).openapi("SleepScheduleCreate");

  const SleepScheduleUpdate = strict({
    daysOfWeek: DaysOfWeek.optional(),
    stopTime: TimeOfDay.optional(),
    startTime: TimeOfDay.optional(),
    timezone: TimeZone.optional(),
    paused: z.boolean().optional(),
  }).openapi("SleepScheduleUpdate");

  const SchedulePreviewRequest = strict({
    resourceId: z.string(),
    accountId: Uuid,
    daysOfWeek: DaysOfWeek,
    stopTime: TimeOfDay,
    startTime: TimeOfDay,
    timezone: TimeZone,
  }).openapi("SleepSchedulePreviewRequest");

  const ScheduleTransition = strict({
    at: IsoDateTime,
    action: ScheduleAction,
  }).openapi("ScheduleTransition");

  const SchedulePreview = strict({
    offFraction: z
      .number()
      .describe("Fraction of the week (0–1) the schedule keeps the resource stopped."),
    monthlyCost: z
      .number()
      .nullable()
      .describe("Trailing spend normalized to a month; null when billing holds no rows."),
    projectedMonthlySaving: z.number().nullable(),
    currency: z.string().nullable(),
    costWindowDays: z
      .number()
      .int()
      .describe("Days of billing data the estimate was computed over (0 = none found)."),
    nextTransitions: z
      .array(ScheduleTransition)
      .describe("The next few transitions, soonest first — a timezone sanity check."),
  }).openapi("SleepSchedulePreview");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/schedules",
    tags: ["Sleep schedules"],
    summary: "List sleep/wake schedules",
    description:
      "Every schedule in the organization with its next transition, last run outcome and a " +
      "projected monthly saving computed from trailing per-resource spend and the weekly " +
      "off-hours fraction. Schedules attach to resources whose plugin declares lifecycle " +
      "start/stop actions; the poller executes due transitions server-side.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The organization's schedules",
        content: { "application/json": { schema: SleepScheduleList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/schedules",
    tags: ["Sleep schedules"],
    summary: "Create a sleep/wake schedule",
    description:
      "Attach an off-at/on-at weekly window to a resource. The resource's type must declare " +
      "lifecycle start/stop actions (see the resource type metadata); one schedule per " +
      "resource. Times are wall-clock in the given IANA timezone and remain correct across " +
      "DST. Audit-logged.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SleepScheduleCreate } } },
    },
    responses: {
      201: {
        description: "The created schedule",
        content: { "application/json": { schema: SleepSchedule } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: {
        description: "The resource already has a schedule",
        content: {
          "application/json": { schema: strict({ error: z.string() }).openapi("ScheduleConflict") },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/schedules/preview",
    tags: ["Sleep schedules"],
    summary: "Preview a schedule's projected saving",
    description:
      "Quote a timing against a resource before saving: the weekly off-hours fraction, the " +
      "resource's trailing spend normalized to a month, the projected monthly saving, and " +
      "the next few transitions. Makes no provider API calls and changes nothing.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: SchedulePreviewRequest } } },
    },
    responses: {
      200: {
        description: "The projected saving and upcoming transitions",
        content: { "application/json": { schema: SchedulePreview } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/schedules/{scheduleId}",
    tags: ["Sleep schedules"],
    summary: "Update or pause a schedule",
    description:
      "Edit the timing and/or toggle `paused`. Any change recomputes the next transition; " +
      "pausing clears it. Audit-logged.",
    request: {
      params: OrgIdParam.extend({ scheduleId: Uuid }),
      body: { content: { "application/json": { schema: SleepScheduleUpdate } } },
    },
    responses: {
      200: {
        description: "The updated schedule",
        content: { "application/json": { schema: SleepSchedule } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/schedules/{scheduleId}",
    tags: ["Sleep schedules"],
    summary: "Delete a schedule",
    description:
      "Remove the schedule. The resource is left in whatever state it is in. Audit-logged.",
    request: { params: OrgIdParam.extend({ scheduleId: Uuid }) },
    responses: {
      204: { description: "Deleted" },
      404: ErrorResponses[404],
    },
  });
}
