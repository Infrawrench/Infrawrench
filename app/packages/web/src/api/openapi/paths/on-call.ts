import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

export function registerOnCallPaths(ctx: BuildContext) {
  const { registry } = ctx;

  const OnCallParticipant = strict({
    userId: Uuid,
    name: z.string().nullable(),
    email: z.string().nullable(),
  }).openapi("OnCallParticipant");

  const OnCallSchedule = strict({
    id: Uuid,
    name: z.string(),
    timezone: z.string().openapi({ example: "Europe/London" }),
    rotationDays: z
      .number()
      .int()
      .describe("Days per shift. 7 is the common case; 1 gives a daily rotation."),
    handoffTime: z
      .string()
      .openapi({ example: "09:00" })
      .describe("Wall-clock time in `timezone` at which the shift changes hands."),
    startDate: z
      .string()
      .openapi({ example: "2026-08-03" })
      .describe(
        "The calendar date in `timezone` the first shift begins on. Every later boundary is " +
          "derived from it, so moving this re-anchors the whole rotation.",
      ),
    participants: z
      .array(OnCallParticipant)
      .describe("Rotation order. Reordering re-plans the future, deliberately."),
    enabled: z
      .boolean()
      .describe(
        "Off resolves to nobody. A routing destination pointing at a disabled rotation " +
          "contributes nobody and the rule's other destinations still deliver.",
      ),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  }).openapi("OnCallSchedule");

  const OnCallShift = strict({
    startsAt: IsoDateTime,
    endsAt: IsoDateTime,
    userId: Uuid,
    name: z.string().nullable(),
    email: z.string().nullable(),
    source: z.enum(["rotation", "override"]),
    rotationIndex: z.number().int().nullable(),
  }).openapi("OnCallShift");

  const OnCallOverride = strict({
    id: Uuid,
    scheduleId: Uuid,
    userId: Uuid,
    userName: z.string().nullable(),
    startsAt: IsoDateTime,
    endsAt: IsoDateTime,
    reason: z.string().nullable(),
    createdByUserId: Uuid.nullable(),
    createdAt: IsoDateTime,
  }).openapi("OnCallOverride");

  const OnCallScheduleList = strict({
    schedules: z.array(OnCallSchedule),
  }).openapi("OnCallScheduleList");

  const OnCallNowEntry = strict({
    scheduleId: Uuid,
    scheduleName: z.string(),
    enabled: z.boolean(),
    shift: OnCallShift.nullable(),
    next: OnCallParticipant.nullable().describe(
      "The next person in the rotation — where an escalation goes. Resolved from the rotation " +
        "and never from a cover: a cover is somebody standing in for one shift.",
    ),
  }).openapi("OnCallNowEntry");

  const OnCallNowResponse = strict({
    onCall: z.array(OnCallNowEntry),
    generatedAt: IsoDateTime,
  }).openapi("OnCallNowResponse");

  const OnCallShiftsResponse = strict({
    shifts: z.array(OnCallShift),
    overrides: z
      .array(OnCallOverride)
      .describe(
        "Covers overlapping the previewed window, returned **separately** rather than merged " +
          "into the shifts: a preview that folded them in would make it impossible to see what " +
          "the rotation itself does, which is the thing being edited.",
      ),
  }).openapi("OnCallShiftsResponse");

  const OnCallScheduleCreate = strict({
    name: z.string().min(1).max(80),
    timezone: z.string(),
    rotationDays: z.number().int().min(1).max(31),
    handoffTime: z.string(),
    startDate: z.string(),
    participantUserIds: z.array(Uuid).min(1).max(60),
    enabled: z.boolean().optional(),
  }).openapi("OnCallScheduleCreate");

  const OnCallScheduleUpdate = OnCallScheduleCreate.partial().openapi("OnCallScheduleUpdate");

  const OnCallOverrideCreate = strict({
    scheduleId: Uuid,
    userId: Uuid,
    startsAt: IsoDateTime,
    endsAt: IsoDateTime,
    reason: z.string().max(200).nullable().optional(),
  }).openapi("OnCallOverrideCreate");

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/on-call/now",
    tags: ["On-call"],
    summary: "Who is on call right now",
    description:
      "One entry per rotation: the shift in effect, and the next person in the rotation. Takes " +
      "`team:read` — knowing who is on call is something every member needs and nobody should " +
      "have to ask an admin for.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The current shift per rotation",
        content: { "application/json": { schema: OnCallNowResponse } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/on-call/schedules",
    tags: ["On-call"],
    summary: "List on-call rotations",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Rotations, by name",
        content: { "application/json": { schema: OnCallScheduleList } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/on-call/schedules",
    tags: ["On-call"],
    summary: "Create an on-call rotation",
    description:
      "Shift boundaries are calendar-day arithmetic in the rotation's own zone, not 24-hour " +
      "arithmetic: a rotation stepped in fixed milliseconds drifts an hour at each daylight-saving " +
      "change until the 09:00 Monday handover happens at 08:00 — or until two people each think " +
      "the other is on call.\n\n" +
      "Writing takes `org:settings:write`: a rotation decides who gets woken up.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: OnCallScheduleCreate } } },
    },
    responses: {
      200: {
        description: "The created rotation",
        content: { "application/json": { schema: OnCallSchedule } },
      },
      400: ErrorResponses[400],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/api/org/{orgId}/on-call/schedules/{scheduleId}",
    tags: ["On-call"],
    summary: "Edit an on-call rotation",
    description:
      "Omitted fields are left alone, and the result is validated after merging. Sending " +
      "`participantUserIds` replaces the list wholesale — position is rotation order, so " +
      "reordering re-plans the future.",
    request: {
      params: OrgIdParam.extend({ scheduleId: Uuid }),
      body: { content: { "application/json": { schema: OnCallScheduleUpdate } } },
    },
    responses: {
      200: {
        description: "The updated rotation",
        content: { "application/json": { schema: OnCallSchedule } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/on-call/schedules/{scheduleId}",
    tags: ["On-call"],
    summary: "Delete an on-call rotation",
    description: "Takes its covers with it. Routing rules naming it resolve to nobody afterwards.",
    request: { params: OrgIdParam.extend({ scheduleId: Uuid }) },
    responses: { 204: { description: "The rotation was deleted" }, 404: ErrorResponses[404] },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/on-call/schedules/{scheduleId}/shifts",
    tags: ["On-call"],
    summary: "Preview upcoming shifts",
    description:
      "The same computation the alert path resolves with, so a preview can never disagree with " +
      "who actually gets woken up.",
    request: {
      params: OrgIdParam.extend({ scheduleId: Uuid }),
      query: z.object({ count: z.coerce.number().int().min(1).max(60).optional() }),
    },
    responses: {
      200: {
        description: "Upcoming shifts and the covers over them",
        content: { "application/json": { schema: OnCallShiftsResponse } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/on-call/overrides",
    tags: ["On-call"],
    summary: "List covers",
    request: {
      params: OrgIdParam,
      query: z.object({ scheduleId: Uuid.optional() }),
    },
    responses: {
      200: {
        description: "Covers, soonest first",
        content: {
          "application/json": { schema: strict({ overrides: z.array(OnCallOverride) }) },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/on-call/overrides",
    tags: ["On-call"],
    summary: "Arrange cover",
    description:
      "A cover beats the rotation for exactly its window. Among several overlapping covers the " +
      "one that **started most recently** wins, so a later-written cover supersedes an earlier " +
      "one rather than the answer depending on row order.\n\n" +
      "Takes `team:read`, not a settings permission: cover is arranged at 17:55 on a Friday and " +
      "the person handing over is rarely an org admin. Every cover is audit-logged, which is the " +
      "control that makes the looser permission safe.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: OnCallOverrideCreate } } },
    },
    responses: {
      200: {
        description: "The cover",
        content: { "application/json": { schema: OnCallOverride } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/on-call/overrides/{overrideId}",
    tags: ["On-call"],
    summary: "Cancel a cover",
    request: { params: OrgIdParam.extend({ overrideId: Uuid }) },
    responses: { 204: { description: "The cover was cancelled" }, 404: ErrorResponses[404] },
  });
}
