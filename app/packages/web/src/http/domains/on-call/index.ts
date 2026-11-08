/**
 * On-call rotations: `/api/org/:orgId/on-call`, the handlers. The store is
 * promise code and runs through `legacy`; the write bodies are checked here,
 * field by field, with the sentences the routes always answered with.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { upcomingOnCallShifts, type OnCallScheduleInput } from "@infrawrench/client-core";
import {
  OnCallInputError,
  createOnCallOverride,
  createOnCallSchedule,
  deleteOnCallOverride,
  deleteOnCallSchedule,
  getOnCallSchedule,
  listOnCallOverrides,
  listOnCallSchedules,
  resolveOnCallNow,
  updateOnCallSchedule,
} from "@infrawrench/server-core/on-call/store";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { notFound, badRequest } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { inputRefusal } from "../../refusals";
import { readObjectBody } from "../../request-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  OnCallApi,
  OnCallNowResponse,
  OnCallOverride,
  OnCallOverrideList,
  OnCallSchedule,
  OnCallScheduleList,
  OnCallShiftsResponse,
} from "./api";

type ScheduleFields =
  | { readonly ok: true; readonly value: Partial<OnCallScheduleInput> }
  | { readonly ok: false; readonly error: string };

const STRING_FIELDS = ["name", "timezone", "handoffTime", "startDate"] as const;

function readScheduleBody(body: { readonly [key: string]: unknown }): ScheduleFields {
  const out: Partial<OnCallScheduleInput> = {};
  for (const key of STRING_FIELDS) {
    if (key in body) {
      const raw = body[key];
      if (!Predicate.isString(raw)) return { ok: false, error: `${key} must be a string` };
      out[key] = raw;
    }
  }
  if ("rotationDays" in body) {
    const raw = body["rotationDays"];
    if (!Predicate.isNumber(raw) || !Number.isInteger(raw)) {
      return { ok: false, error: "rotationDays must be a whole number" };
    }
    out.rotationDays = raw;
  }
  if ("participantUserIds" in body) {
    const raw = body["participantUserIds"];
    if (!Array.isArray(raw) || !raw.every(Predicate.isString)) {
      return { ok: false, error: "participantUserIds must be an array of strings" };
    }
    out.participantUserIds = raw;
  }
  if ("enabled" in body) {
    const raw = body["enabled"];
    if (!Predicate.isBoolean(raw)) return { ok: false, error: "enabled must be a boolean" };
    out.enabled = raw;
  }
  return { ok: true, value: out };
}

/**
 * A create body as the store's input. A field the body left out is given the
 * value `validateOnCallSchedule` refuses with the same sentence as a missing
 * one ("A name is required.", "Choose a valid time zone.", ...), so the store
 * still answers for it.
 */
const scheduleInput = (fields: Partial<OnCallScheduleInput>): OnCallScheduleInput => ({
  ...fields,
  name: fields.name ?? "",
  timezone: fields.timezone ?? "",
  rotationDays: fields.rotationDays ?? Number.NaN,
  handoffTime: fields.handoffTime ?? "",
  startDate: fields.startDate ?? "",
  participantUserIds: fields.participantUserIds ?? [],
});

const storeRefusal = (error: unknown) =>
  error instanceof OnCallInputError ? inputRefusal(error) : undefined;

const OnCallHandlers = HttpApiBuilder.group(OnCallApi, "onCall", (handlers) =>
  handlers
    .handle("listSchedules", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const schedules = yield* legacy(() => listOnCallSchedules(organizationId));
        return yield* respond(OnCallScheduleList)({ schedules });
      }),
    )
    // The read a phone, a Slack command or a dashboard tile wants: it answers
    // the question without the caller having to know the rotation arithmetic.
    .handle("now", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const { entries, now } = yield* legacy(async () => {
          const schedules = await listOnCallSchedules(organizationId);
          const now = Date.now();
          const entries = await Promise.all(
            schedules.map(async (schedule) => {
              const resolved = await resolveOnCallNow(organizationId, schedule.id, now);
              return {
                scheduleId: schedule.id,
                scheduleName: schedule.name,
                enabled: schedule.enabled,
                shift: resolved.shift,
                next: resolved.next,
              };
            }),
          );
          return { entries, now };
        });
        return yield* respond(OnCallNowResponse)({
          onCall: entries,
          generatedAt: new Date(now).toISOString(),
        });
      }),
    )
    // Rotation shifts and covers are returned separately rather than merged: a
    // preview that silently folded covers in would make it impossible to see
    // what the rotation itself does, which is the thing being edited.
    .handle("shifts", ({ params, query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const schedule = yield* legacy(() => getOnCallSchedule(organizationId, params.scheduleId));
        if (!schedule) return yield* notFound("No such rotation");
        const count = query.count ?? 8;
        const now = Date.now();
        const shifts = upcomingOnCallShifts(schedule, now, count);
        const last = shifts[shifts.length - 1];
        const overrides = yield* legacy(() =>
          listOnCallOverrides(organizationId, {
            scheduleId: params.scheduleId,
            from: new Date(now),
            ...(last ? { to: new Date(last.endsAt) } : {}),
          }),
        );
        return yield* respond(OnCallShiftsResponse)({ shifts, overrides });
      }),
    )
    .handleRaw("createSchedule", ({ request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const fields = readScheduleBody(parsed.body);
        if (!fields.ok) return yield* badRequest(fields.error);

        const { organizationId, session } = yield* OrgPrincipal;
        const schedule = yield* legacyTry(
          () =>
            createOnCallSchedule(
              organizationId,
              scheduleInput(fields.value),
              session.userId ?? null,
            ),
          storeRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "on_call_schedule.create",
            entityType: "on_call_schedule",
            entityId: schedule.id,
            metadata: { name: schedule.name, participants: schedule.participants.length },
          }),
        );
        return yield* respond(OnCallSchedule)(schedule);
      }),
    )
    .handleRaw("updateSchedule", ({ params, request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const fields = readScheduleBody(parsed.body);
        if (!fields.ok) return yield* badRequest(fields.error);
        if (Object.keys(fields.value).length === 0) return yield* badRequest("No changes supplied");

        const { organizationId, session } = yield* OrgPrincipal;
        const schedule = yield* legacyTry(
          () => updateOnCallSchedule(organizationId, params.scheduleId, fields.value),
          storeRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "on_call_schedule.update",
            entityType: "on_call_schedule",
            entityId: schedule.id,
            metadata: {
              name: schedule.name,
              participants: schedule.participants.length,
              enabled: schedule.enabled,
            },
          }),
        );
        return yield* respond(OnCallSchedule)(schedule);
      }),
    )
    .handle("deleteSchedule", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const removed = yield* legacy(() =>
          deleteOnCallSchedule(organizationId, params.scheduleId),
        );
        if (!removed) return yield* notFound("No such rotation");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "on_call_schedule.delete",
            entityType: "on_call_schedule",
            entityId: params.scheduleId,
          }),
        );
      }),
    )
    .handle("listOverrides", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const scheduleId = query.scheduleId;
        const overrides = yield* legacy(() =>
          listOnCallOverrides(organizationId, { ...(scheduleId ? { scheduleId } : {}) }),
        );
        return yield* respond(OnCallOverrideList)({ overrides });
      }),
    )
    // `team:read`, deliberately: cover is arranged at 17:55 on a Friday, and
    // the person handing over is rarely an org admin. The audit entry is what
    // makes that safe.
    .handleRaw("createOverride", ({ request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const body = parsed.body;
        const scheduleId = body["scheduleId"];
        const userId = body["userId"];
        const startsAt = body["startsAt"];
        const endsAt = body["endsAt"];
        if (!Predicate.isString(scheduleId)) return yield* badRequest("scheduleId is required");
        if (!Predicate.isString(userId)) return yield* badRequest("userId is required");
        if (!Predicate.isString(startsAt)) return yield* badRequest("startsAt is required");
        if (!Predicate.isString(endsAt)) return yield* badRequest("endsAt is required");
        const reason = body["reason"];
        if (reason !== undefined && reason !== null && !Predicate.isString(reason)) {
          return yield* badRequest("reason must be a string or null");
        }

        const { organizationId, session } = yield* OrgPrincipal;
        const override = yield* legacyTry(
          () =>
            createOnCallOverride(
              organizationId,
              { scheduleId, userId, startsAt, endsAt, reason: reason ?? null },
              session.userId ?? null,
            ),
          storeRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "on_call_override.create",
            entityType: "on_call_override",
            entityId: override.id,
            metadata: {
              scheduleId: override.scheduleId,
              coveringUserId: override.userId,
              startsAt: override.startsAt,
              endsAt: override.endsAt,
            },
          }),
        );
        return yield* respond(OnCallOverride)(override);
      }),
    )
    .handle("deleteOverride", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const removed = yield* legacy(() =>
          deleteOnCallOverride(organizationId, params.overrideId),
        );
        if (!removed) return yield* notFound("No such cover");
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "on_call_override.delete",
            entityType: "on_call_override",
            entityId: params.overrideId,
          }),
        );
      }),
    ),
);

export const onCallDomain = makeDomain("on-call", OnCallApi, OnCallHandlers);
