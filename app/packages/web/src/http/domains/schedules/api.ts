/**
 * Sleep/wake schedules: `/api/org/:orgId/schedules`, the endpoint definitions.
 *
 * "Off at 19:00, on at 08:00, Mon-Fri" windows on resources whose plugin
 * declares a `lifecycle` start/stop action pair. Execution happens in the
 * poller (`server-core/src/schedules/pass.ts`); these endpoints only manage
 * the rows and quote projected savings.
 *
 * Permissions: reads are `resources:read` (the list is derived from the org's
 * resource set, like orphans); mutations are `resources:write`; a schedule is
 * a standing instruction to invoke the same actions that permission already
 * gates on `/resources/invoke-action`.
 *
 * The write bodies are documented here and checked by hand in the handlers,
 * whose 400s name the field at fault, so those endpoints are served raw.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength, pattern } from "@infrawrench/ui/schemas";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgId, OrgParams, Uuid } from "../../schemas/common";
import { optionalRequestBody } from "../../schemas/documented";
import { PluginId } from "../../schemas/plugin-registry";
import { FindingRemediation } from "../../schemas/remediation";

/** The 409 a second schedule on one resource is refused with. */
export class ScheduleConflict extends Schema.Error<ScheduleConflict>(
  "infrawrench/http/ScheduleConflict",
)(
  { error: Schema.String },
  {
    httpApiStatus: 409,
    identifier: "ScheduleConflict",
    description: "The resource already has a schedule",
  },
) {}

/** Wall-clock "HH:MM", 24-hour: the same shape the MCP tool schema enforces. */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const ScheduleAction = Schema.Literals(["stop", "start"]).annotate({
  description: "A schedule transition: `stop` powers the resource off, `start` powers it on.",
});

const ScheduleRunStatus = Schema.Literals(["ok", "failed", "skipped_freeze"]).annotate({
  description:
    "Outcome of the last executed transition: `ok`, `failed` (see `lastRunError`), or " +
    "`skipped_freeze` (an org change freeze was in effect, so the transition was skipped).",
});

const DaysOfWeek = Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 7 })))
  .check(minLength(1), maxLength(7))
  .annotate({
    description: "ISO weekdays the resource is worked on: 1 = Monday … 7 = Sunday.",
    examples: [[1, 2, 3, 4, 5]],
  });

const TimeOfDay = Schema.String.check(pattern(TIME_RE)).annotate({
  description: 'Wall-clock time of day, 24-hour `"HH:MM"`, in the schedule\'s timezone.',
  examples: ["19:00"],
});

const TimeZone = Schema.String.annotate({
  description: "IANA timezone the wall-clock times are computed in (DST-safe).",
  examples: ["Europe/London"],
});

export const SleepSchedule = Schema.Struct({
  id: Uuid,
  resourceId: Schema.String.annotate({
    description: "Infrawrench resource id the schedule powers on and off.",
  }),
  accountId: Uuid,
  pluginId: PluginId,
  resourceTypeId: Schema.String,
  resourceName: Schema.String.annotate({ description: "Resource display name at read time." }),
  accountName: Schema.String,
  daysOfWeek: DaysOfWeek,
  stopTime: TimeOfDay.annotate({
    description: "When the resource is stopped on each selected day.",
  }),
  startTime: TimeOfDay.annotate({
    description: "When the resource is started on each selected day.",
  }),
  timezone: TimeZone,
  paused: Schema.Boolean.annotate({
    description: "Paused schedules keep their timing but never fire.",
  }),
  nextTransitionAt: Schema.NullOr(IsoDateTime).annotate({
    description: "Next due transition; null while paused.",
  }),
  nextTransitionAction: Schema.NullOr(ScheduleAction),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunAction: Schema.NullOr(ScheduleAction),
  lastRunStatus: Schema.NullOr(ScheduleRunStatus),
  lastRunError: Schema.NullOr(Schema.String).annotate({
    description: "Failure detail for a failed run.",
  }),
  projectedMonthlySaving: Schema.NullOr(Schema.Finite).annotate({
    description:
      "Projected monthly saving from trailing per-resource spend × the weekly off-hours " +
      "fraction; null when billing holds no rows for the resource.",
  }),
  currency: Schema.NullOr(Schema.String).annotate({
    description: "Currency of the projection, when present.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  remediation: Schema.optionalKey(FindingRemediation).annotateKey({
    description: "Provider CLI stop/start commands for the resource, for doing it by hand.",
  }),
}).annotate({ identifier: "SleepSchedule" });

export const SleepScheduleList = Schema.Struct({
  schedules: Schema.Array(SleepSchedule),
}).annotate({ identifier: "SleepScheduleList" });

const timingFields = {
  daysOfWeek: DaysOfWeek,
  stopTime: TimeOfDay,
  startTime: TimeOfDay,
  timezone: TimeZone,
};

const SleepScheduleCreate = Schema.Struct({
  resourceId: Schema.String,
  accountId: Uuid,
  ...timingFields,
}).annotate({ identifier: "SleepScheduleCreate" });

const SleepScheduleUpdate = Schema.Struct({
  daysOfWeek: Schema.optionalKey(DaysOfWeek),
  stopTime: Schema.optionalKey(TimeOfDay),
  startTime: Schema.optionalKey(TimeOfDay),
  timezone: Schema.optionalKey(TimeZone),
  paused: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "SleepScheduleUpdate" });

const SchedulePreviewRequest = Schema.Struct({
  resourceId: Schema.String,
  accountId: Uuid,
  ...timingFields,
}).annotate({ identifier: "SleepSchedulePreviewRequest" });

const ScheduleTransition = Schema.Struct({
  at: IsoDateTime,
  action: ScheduleAction,
}).annotate({ identifier: "ScheduleTransition" });

export const SchedulePreview = Schema.Struct({
  offFraction: Schema.Finite.annotate({
    description: "Fraction of the week (0–1) the schedule keeps the resource stopped.",
  }),
  monthlyCost: Schema.NullOr(Schema.Finite).annotate({
    description: "Trailing spend normalized to a month; null when billing holds no rows.",
  }),
  projectedMonthlySaving: Schema.NullOr(Schema.Finite),
  currency: Schema.NullOr(Schema.String),
  costWindowDays: Schema.Int.annotate({
    description: "Days of billing data the estimate was computed over (0 = none found).",
  }),
  nextTransitions: Schema.Array(ScheduleTransition).annotate({
    description: "The next few transitions, soonest first; a timezone sanity check.",
  }),
}).annotate({ identifier: "SleepSchedulePreview" });

const ScheduleParams = { orgId: OrgId, scheduleId: Uuid } as const;

export class SchedulesGroup extends HttpApiGroup.make("schedules")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: SleepScheduleList,
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "List sleep/wake schedules")
      .annotate(
        OpenApi.Description,
        "Every schedule in the organization with its next transition, last run outcome and a " +
          "projected monthly saving computed from trailing per-resource spend and the weekly " +
          "off-hours fraction. Schedules attach to resources whose plugin declares lifecycle " +
          "start/stop actions; the poller executes due transitions server-side.",
      )
      .annotate(SuccessDescription, "The organization's schedules"),
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: SleepScheduleCreate,
      success: SleepSchedule.pipe(HttpApiSchema.status(201)),
      error: [BadRequest, NotFound, ScheduleConflict],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Create a sleep/wake schedule")
      .annotate(
        OpenApi.Description,
        "Attach an off-at/on-at weekly window to a resource. The resource's type must declare " +
          "lifecycle start/stop actions (see the resource type metadata); one schedule per " +
          "resource. Times are wall-clock in the given IANA timezone and remain correct across " +
          "DST. Audit-logged.",
      )
      .annotate(SuccessDescription, "The created schedule")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("preview", "/preview", {
      params: OrgParams,
      payload: SchedulePreviewRequest,
      success: SchedulePreview,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:read")
      .annotate(OpenApi.Summary, "Preview a schedule's projected saving")
      .annotate(
        OpenApi.Description,
        "Quote a timing against a resource before saving: the weekly off-hours fraction, the " +
          "resource's trailing spend normalized to a month, the projected monthly saving, and " +
          "the next few transitions. Makes no provider API calls and changes nothing.",
      )
      .annotate(SuccessDescription, "The projected saving and upcoming transitions")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.put("update", "/:scheduleId", {
      params: ScheduleParams,
      payload: SleepScheduleUpdate,
      success: SleepSchedule,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Update or pause a schedule")
      .annotate(
        OpenApi.Description,
        "Edit the timing and/or toggle `paused`. Any change recomputes the next transition; " +
          "pausing clears it. Audit-logged.",
      )
      .annotate(SuccessDescription, "The updated schedule")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("delete", "/:scheduleId", {
      params: ScheduleParams,
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "resources:write")
      .annotate(OpenApi.Summary, "Delete a schedule")
      .annotate(
        OpenApi.Description,
        "Remove the schedule. The resource is left in whatever state it is in. Audit-logged.",
      )
      .annotate(SuccessDescription, "Deleted"),
  )
  .prefix("/api/org/:orgId/schedules")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Sleep schedules") {}

export class SchedulesApi extends withApiDefaults(HttpApi.make("schedules").add(SchedulesGroup)) {}
