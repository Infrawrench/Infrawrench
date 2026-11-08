/**
 * Sleep/wake schedules: `/api/org/:orgId/schedules`, the handlers. The store
 * is promise code and runs through `legacy`; the write bodies are checked
 * here, field by field, with the sentences the routes always answered with.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  getScheduleWire,
  listSchedules,
  previewSchedule,
} from "@infrawrench/server-core/schedules/feed";
import {
  ScheduleInputError,
  createScheduleRecord,
  deleteScheduleRecord,
  updateScheduleRecord,
  type ScheduleCreateInput,
  type ScheduleUpdateInput,
} from "@infrawrench/server-core/schedules/store";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { badRequest } from "../../errors";
import { legacy } from "../../legacy";
import { readObjectBody } from "../../request-body";
import { refuse, refusalCall, type RefusalPolicy, refusalsOf } from "../../refusals";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  ScheduleConflict,
  SchedulePreview,
  SchedulesApi,
  SleepSchedule,
  SleepScheduleList,
  TIME_RE,
} from "./api";

const store: RefusalPolicy = refusalsOf(ScheduleInputError, {
  logPrefix: "[schedules]",
  failure: "Schedule operation failed",
});

const badRequestOr404 = { 400: refuse[400], 404: refuse[404] } as const;

interface Timing {
  daysOfWeek?: number[];
  stopTime?: string;
  startTime?: string;
  timezone?: string;
}

const isWeekday = (d: unknown): d is number =>
  Predicate.isNumber(d) && Number.isInteger(d) && d >= 1 && d <= 7;

function readTiming(
  body: { readonly [key: string]: unknown },
  { partial }: { partial: boolean },
): { error: string } | { timing: Timing } {
  const timing: Timing = {};
  const days = body["daysOfWeek"];
  if (days !== undefined || !partial) {
    if (!Array.isArray(days) || days.length < 1 || days.length > 7 || !days.every(isWeekday)) {
      return { error: "daysOfWeek must be an array of ISO weekday numbers (1–7)" };
    }
    timing.daysOfWeek = days;
  }
  for (const key of ["stopTime", "startTime", "timezone"] as const) {
    const value = body[key];
    if (value !== undefined || !partial) {
      if (!Predicate.isString(value)) return { error: `${key} must be a string` };
      if (key !== "timezone" && !TIME_RE.test(value)) {
        return { error: `${key} must be in 24-hour HH:MM format` };
      }
      timing[key] = value;
    }
  }
  return { timing };
}

/** A full create or preview body: target plus complete timing. */
const readFullBody = Effect.fnUntraced(function* (body: { readonly [key: string]: unknown }) {
  const resourceId = body["resourceId"];
  const accountId = body["accountId"];
  if (!Predicate.isString(resourceId) || !Predicate.isString(accountId)) {
    return yield* badRequest("resourceId and accountId are required");
  }
  const read = readTiming(body, { partial: false });
  if ("error" in read) return yield* badRequest(read.error);
  const { daysOfWeek, stopTime, startTime, timezone } = read.timing;
  if (!daysOfWeek || stopTime === undefined || startTime === undefined || timezone === undefined) {
    return yield* badRequest("daysOfWeek must be an array of ISO weekday numbers (1–7)");
  }
  const input: ScheduleCreateInput = {
    resourceId,
    accountId,
    daysOfWeek,
    stopTime,
    startTime,
    timezone,
  };
  return input;
});

const SchedulesHandlers = HttpApiBuilder.group(SchedulesApi, "schedules", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const schedules = yield* legacy(() => listSchedules(organizationId));
        return yield* respond(SleepScheduleList)(schedules);
      }),
    )
    .handleRaw("preview", ({ request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const input = yield* readFullBody(parsed.body);
        const { organizationId } = yield* OrgPrincipal;
        const preview = yield* refusalCall(store, badRequestOr404, () =>
          previewSchedule(organizationId, input),
        );
        return yield* respond(SchedulePreview)(preview);
      }),
    )
    .handleRaw("create", ({ request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const input = yield* readFullBody(parsed.body);
        const { organizationId, session } = yield* OrgPrincipal;
        const wire = yield* refusalCall(
          store,
          { ...badRequestOr404, 409: (error: string) => new ScheduleConflict({ error }) },
          async () => {
            const created = await createScheduleRecord(organizationId, input, session.userId);
            void logAudit({
              organizationId,
              userId: session.userId,
              action: "resource_schedule.create",
              entityType: "resource_schedule",
              entityId: created.id,
              metadata: {
                resourceId: created.resourceId,
                pluginId: created.pluginId,
                resourceTypeId: created.resourceTypeId,
                daysOfWeek: created.daysOfWeek,
                stopTime: created.stopTime,
                startTime: created.startTime,
                timezone: created.timezone,
              },
            });
            return getScheduleWire(organizationId, created.id);
          },
        );
        return yield* respond(SleepSchedule, { status: 201 })(wire);
      }),
    )
    .handleRaw("update", ({ params, request }) =>
      Effect.gen(function* () {
        const parsed = yield* readObjectBody(request);
        if (!parsed.ok) return yield* badRequest(parsed.error);
        const body = parsed.body;
        const read = readTiming(body, { partial: true });
        if ("error" in read) return yield* badRequest(read.error);
        const patch: ScheduleUpdateInput = { ...read.timing };
        const paused = body["paused"];
        if (paused !== undefined) {
          if (!Predicate.isBoolean(paused)) return yield* badRequest("paused must be a boolean");
          patch.paused = paused;
        }
        if (Object.keys(patch).length === 0) return yield* badRequest("No changes supplied");

        const { organizationId, session } = yield* OrgPrincipal;
        const wire = yield* refusalCall(store, badRequestOr404, async () => {
          const updated = await updateScheduleRecord(organizationId, params.scheduleId, patch);
          void logAudit({
            organizationId,
            userId: session.userId,
            action: "resource_schedule.update",
            entityType: "resource_schedule",
            entityId: updated.id,
            metadata: { resourceId: updated.resourceId, patch: { ...patch } },
          });
          return getScheduleWire(organizationId, updated.id);
        });
        return yield* respond(SleepSchedule)(wire);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        yield* refusalCall(store, { 404: refuse[404] }, async () => {
          const deleted = await deleteScheduleRecord(organizationId, params.scheduleId);
          void logAudit({
            organizationId,
            userId: session.userId,
            action: "resource_schedule.delete",
            entityType: "resource_schedule",
            entityId: deleted.id,
            metadata: { resourceId: deleted.resourceId, pluginId: deleted.pluginId },
          });
        });
      }),
    ),
);

export const schedulesDomain = makeDomain("schedules", SchedulesApi, SchedulesHandlers);
