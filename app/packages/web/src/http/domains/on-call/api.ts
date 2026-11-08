/**
 * On-call rotations: `/api/org/:orgId/on-call`, the endpoint definitions.
 *
 * Reading takes `team:read` (knowing who is on call is something every member
 * needs), writing a rotation `org:settings:write` (it decides who gets woken
 * up), and arranging cover `team:read` again, made safe by the audit entry
 * every cover writes.
 *
 * The write bodies are documented here and checked by hand in the handlers,
 * whose 400s name the field at fault, so those endpoints are served raw.
 */
import { Schema, Struct } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { maxLength, minLength } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams, OrgId, Uuid } from "../../schemas/common";
import { numericQuery } from "../../schemas/query";

const OnCallParticipant = Schema.Struct({
  userId: Uuid,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
}).annotate({ identifier: "OnCallParticipant" });

export const OnCallSchedule = Schema.Struct({
  id: Uuid,
  name: Schema.String,
  timezone: Schema.String.annotate({ examples: ["Europe/London"] }),
  rotationDays: Schema.Int.annotate({
    description: "Days per shift. 7 is the common case; 1 gives a daily rotation.",
  }),
  handoffTime: Schema.String.annotate({
    examples: ["09:00"],
    description: "Wall-clock time in `timezone` at which the shift changes hands.",
  }),
  startDate: Schema.String.annotate({
    examples: ["2026-08-03"],
    description:
      "The calendar date in `timezone` the first shift begins on. Every later boundary is " +
      "derived from it, so moving this re-anchors the whole rotation.",
  }),
  participants: Schema.Array(OnCallParticipant).annotate({
    description: "Rotation order. Reordering re-plans the future, deliberately.",
  }),
  enabled: Schema.Boolean.annotate({
    description:
      "Off resolves to nobody. A routing destination pointing at a disabled rotation " +
      "contributes nobody and the rule's other destinations still deliver.",
  }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "OnCallSchedule" });

const OnCallShift = Schema.Struct({
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  userId: Uuid,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  source: Schema.Literals(["rotation", "override"]),
  rotationIndex: Schema.NullOr(Schema.Int),
}).annotate({ identifier: "OnCallShift" });

export const OnCallOverride = Schema.Struct({
  id: Uuid,
  scheduleId: Uuid,
  userId: Uuid,
  userName: Schema.NullOr(Schema.String),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  reason: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Uuid),
  createdAt: IsoDateTime,
}).annotate({ identifier: "OnCallOverride" });

export const OnCallScheduleList = Schema.Struct({
  schedules: Schema.Array(OnCallSchedule),
}).annotate({ identifier: "OnCallScheduleList" });

const OnCallNowEntry = Schema.Struct({
  scheduleId: Uuid,
  scheduleName: Schema.String,
  enabled: Schema.Boolean,
  shift: Schema.NullOr(OnCallShift),
  next: Schema.NullOr(OnCallParticipant).annotate({
    description:
      "The next person in the rotation, where an escalation goes. Resolved from the rotation " +
      "and never from a cover: a cover is somebody standing in for one shift.",
  }),
}).annotate({ identifier: "OnCallNowEntry" });

export const OnCallNowResponse = Schema.Struct({
  onCall: Schema.Array(OnCallNowEntry),
  generatedAt: IsoDateTime,
}).annotate({ identifier: "OnCallNowResponse" });

export const OnCallShiftsResponse = Schema.Struct({
  shifts: Schema.Array(OnCallShift),
  overrides: Schema.Array(OnCallOverride).annotate({
    description:
      "Covers overlapping the previewed window, returned **separately** rather than merged " +
      "into the shifts: a preview that folded them in would make it impossible to see what " +
      "the rotation itself does, which is the thing being edited.",
  }),
}).annotate({ identifier: "OnCallShiftsResponse" });

export const OnCallOverrideList = Schema.Struct({ overrides: Schema.Array(OnCallOverride) });

const scheduleCreateFields = {
  name: Schema.String.check(minLength(1), maxLength(80)),
  timezone: Schema.String,
  rotationDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
  handoffTime: Schema.String,
  startDate: Schema.String,
  participantUserIds: Schema.Array(Uuid).check(minLength(1), maxLength(60)),
  enabled: Schema.optionalKey(Schema.Boolean),
};

const OnCallScheduleCreate = Schema.Struct(scheduleCreateFields).annotate({
  identifier: "OnCallScheduleCreate",
});

const OnCallScheduleUpdate = Schema.Struct(
  Struct.map(scheduleCreateFields, Schema.optionalKey),
).annotate({ identifier: "OnCallScheduleUpdate" });

const OnCallOverrideCreate = Schema.Struct({
  scheduleId: Uuid,
  userId: Uuid,
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  reason: Schema.optionalKey(Schema.NullOr(Schema.String.check(maxLength(200)))),
}).annotate({ identifier: "OnCallOverrideCreate" });

/** The most shifts one preview may ask for. */
export const MAX_PREVIEW_SHIFTS = 60;

const ScheduleParams = { orgId: OrgId, scheduleId: Uuid } as const;

export class OnCallGroup extends HttpApiGroup.make("onCall")
  .add(
    HttpApiEndpoint.get("now", "/now", {
      params: OrgParams,
      success: OnCallNowResponse,
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "Who is on call right now")
      .annotate(
        OpenApi.Description,
        "One entry per rotation: the shift in effect, and the next person in the rotation. Takes " +
          "`team:read`: knowing who is on call is something every member needs and nobody should " +
          "have to ask an admin for.",
      )
      .annotate(SuccessDescription, "The current shift per rotation"),
    HttpApiEndpoint.get("listSchedules", "/schedules", {
      params: OrgParams,
      success: OnCallScheduleList,
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "List on-call rotations")
      .annotate(SuccessDescription, "Rotations, by name"),
    HttpApiEndpoint.post("createSchedule", "/schedules", {
      params: OrgParams,
      payload: OnCallScheduleCreate,
      success: OnCallSchedule,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Create an on-call rotation")
      .annotate(
        OpenApi.Description,
        "Shift boundaries are calendar-day arithmetic in the rotation's own zone, not 24-hour " +
          "arithmetic: a rotation stepped in fixed milliseconds drifts an hour at each daylight-saving " +
          "change until the 09:00 Monday handover happens at 08:00; or until two people each think " +
          "the other is on call.\n\n" +
          "Writing takes `org:settings:write`: a rotation decides who gets woken up.",
      )
      .annotate(SuccessDescription, "The created rotation"),
    HttpApiEndpoint.patch("updateSchedule", "/schedules/:scheduleId", {
      params: ScheduleParams,
      payload: OnCallScheduleUpdate,
      success: OnCallSchedule,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Edit an on-call rotation")
      .annotate(
        OpenApi.Description,
        "Omitted fields are left alone, and the result is validated after merging. Sending " +
          "`participantUserIds` replaces the list wholesale; position is rotation order, so " +
          "reordering re-plans the future.",
      )
      .annotate(SuccessDescription, "The updated rotation"),
    HttpApiEndpoint.delete("deleteSchedule", "/schedules/:scheduleId", {
      params: ScheduleParams,
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete an on-call rotation")
      .annotate(
        OpenApi.Description,
        "Takes its covers with it. Routing rules naming it resolve to nobody afterwards.",
      )
      .annotate(SuccessDescription, "The rotation was deleted"),
    HttpApiEndpoint.get("shifts", "/schedules/:scheduleId/shifts", {
      params: ScheduleParams,
      query: {
        count: Schema.optionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PREVIEW_SHIFTS })),
        ),
      },
      success: OnCallShiftsResponse,
      error: [BadRequest, NotFound],
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "Preview upcoming shifts")
      .annotate(
        OpenApi.Description,
        "The same computation the alert path resolves with, so a preview can never disagree with " +
          "who actually gets woken up.",
      )
      .annotate(SuccessDescription, "Upcoming shifts and the covers over them")
      .annotate(
        OpenApi.Transform,
        numericQuery({ count: { type: "integer", minimum: 1, maximum: MAX_PREVIEW_SHIFTS } }),
      )
      .annotate(
        InvalidRequestMessage,
        `count must be a whole number between 1 and ${MAX_PREVIEW_SHIFTS}`,
      ),
    HttpApiEndpoint.get("listOverrides", "/overrides", {
      params: OrgParams,
      query: { scheduleId: Schema.optionalKey(Uuid) },
      success: OnCallOverrideList,
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "List covers")
      .annotate(SuccessDescription, "Covers, soonest first"),
    HttpApiEndpoint.post("createOverride", "/overrides", {
      params: OrgParams,
      payload: OnCallOverrideCreate,
      success: OnCallOverride,
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "Arrange cover")
      .annotate(
        OpenApi.Description,
        "A cover beats the rotation for exactly its window. Among several overlapping covers the " +
          "one that **started most recently** wins, so a later-written cover supersedes an earlier " +
          "one rather than the answer depending on row order.\n\n" +
          "Takes `team:read`, not a settings permission: cover is arranged at 17:55 on a Friday and " +
          "the person handing over is rarely an org admin. Every cover is audit-logged, which is the " +
          "control that makes the looser permission safe.",
      )
      .annotate(SuccessDescription, "The cover"),
    HttpApiEndpoint.delete("deleteOverride", "/overrides/:overrideId", {
      params: { orgId: OrgId, overrideId: Uuid },
      success: HttpApiSchema.NoContent,
      error: NotFound,
    })
      .annotate(RequiredPermission, "team:read")
      .annotate(OpenApi.Summary, "Cancel a cover")
      .annotate(SuccessDescription, "The cover was cancelled"),
  )
  .prefix("/api/org/:orgId/on-call")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "On-call") {}

export class OnCallApi extends withApiDefaults(HttpApi.make("on-call").add(OnCallGroup)) {}
