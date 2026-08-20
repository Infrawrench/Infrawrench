/**
 * On-call rotations — CRUD, and the resolve the alert path calls.
 *
 * The rotation arithmetic itself is in `@infrawrench/client-core`
 * (`resolveOnCall`, `nextOnCall`, `upcomingOnCallShifts`), which is the same
 * function the settings editor previews the next fortnight with. A preview that
 * could disagree with delivery would be worse than no preview at all.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import {
  ON_CALL_LIMITS,
  nextOnCall,
  resolveOnCall,
  validateOnCallOverride,
  validateOnCallSchedule,
  type OnCallOverride,
  type OnCallParticipant,
  type OnCallSchedule,
  type OnCallScheduleInput,
  type OnCallShift,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { users } from "../db/schema";
import { onCallOverrides, onCallParticipants, onCallSchedules } from "../db/on-call-schema";

export class OnCallInputError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "OnCallInputError";
    this.status = status;
  }
}

async function loadParticipants(scheduleIds: string[]): Promise<Map<string, OnCallParticipant[]>> {
  if (scheduleIds.length === 0) return new Map();
  const rows = await db
    .select({
      scheduleId: onCallParticipants.scheduleId,
      userId: onCallParticipants.userId,
      position: onCallParticipants.position,
      name: users.displayName,
      email: users.email,
    })
    .from(onCallParticipants)
    .leftJoin(users, eq(users.id, onCallParticipants.userId))
    .orderBy(asc(onCallParticipants.position));

  const bySchedule = new Map<string, OnCallParticipant[]>();
  for (const row of rows) {
    if (!scheduleIds.includes(row.scheduleId)) continue;
    const list = bySchedule.get(row.scheduleId) ?? [];
    list.push({ userId: row.userId, name: row.name, email: row.email });
    bySchedule.set(row.scheduleId, list);
  }
  return bySchedule;
}

export async function listOnCallSchedules(organizationId: string): Promise<OnCallSchedule[]> {
  const rows = await db
    .select()
    .from(onCallSchedules)
    .where(eq(onCallSchedules.organizationId, organizationId))
    .orderBy(onCallSchedules.name);
  const participants = await loadParticipants(rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    rotationDays: row.rotationDays,
    handoffTime: row.handoffTime,
    startDate: row.startDate,
    participants: participants.get(row.id) ?? [],
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function getOnCallSchedule(
  organizationId: string,
  scheduleId: string,
): Promise<OnCallSchedule | null> {
  const all = await listOnCallSchedules(organizationId);
  return all.find((schedule) => schedule.id === scheduleId) ?? null;
}

/**
 * The subset of the drizzle handle the writer below needs, so it can be called
 * with either `db` or a transaction without either type having to satisfy the
 * other.
 */
type ParticipantWriter = Pick<typeof db, "delete" | "insert">;

/**
 * Replace a schedule's participant list.
 *
 * Delete-then-insert inside one transaction rather than a diff: the list is at
 * most sixty rows, positions shift when anyone is inserted in the middle, and a
 * diff would have to renumber most of them anyway. Doing it wholesale means the
 * unique `(schedule, user)` constraint can never be transiently violated by an
 * update ordering.
 */
async function replaceParticipants(
  tx: ParticipantWriter,
  scheduleId: string,
  userIds: readonly string[],
): Promise<void> {
  await tx.delete(onCallParticipants).where(eq(onCallParticipants.scheduleId, scheduleId));
  if (userIds.length === 0) return;
  await tx.insert(onCallParticipants).values(
    userIds.map((userId, position) => ({
      id: randomUUID(),
      scheduleId,
      userId,
      position,
    })),
  );
}

export async function createOnCallSchedule(
  organizationId: string,
  input: OnCallScheduleInput,
  userId: string | null,
): Promise<OnCallSchedule> {
  const problem = validateOnCallSchedule(input);
  if (problem) throw new OnCallInputError(problem);

  const existing = await db
    .select({ id: onCallSchedules.id })
    .from(onCallSchedules)
    .where(eq(onCallSchedules.organizationId, organizationId));
  if (existing.length >= ON_CALL_LIMITS.maxSchedulesPerOrg) {
    throw new OnCallInputError(
      `An organization may have ${ON_CALL_LIMITS.maxSchedulesPerOrg} rotations.`,
    );
  }

  const id = randomUUID();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(onCallSchedules).values({
        id,
        organizationId,
        name: input.name.trim(),
        timezone: input.timezone,
        rotationDays: input.rotationDays,
        handoffTime: input.handoffTime,
        startDate: input.startDate,
        enabled: input.enabled ?? true,
        createdByUserId: userId,
      });
      await replaceParticipants(tx, id, input.participantUserIds);
    });
  } catch (err) {
    throw asConflict(err, input.name.trim());
  }
  const created = await getOnCallSchedule(organizationId, id);
  if (!created) throw new Error("Failed to create the rotation");
  return created;
}

export async function updateOnCallSchedule(
  organizationId: string,
  scheduleId: string,
  patch: Partial<OnCallScheduleInput>,
): Promise<OnCallSchedule> {
  const current = await getOnCallSchedule(organizationId, scheduleId);
  if (!current) throw new OnCallInputError("No such rotation.", 404);

  // Validated after merging: a patch that only reorders the participants still
  // has to leave a schedule that is valid as a whole.
  const merged: OnCallScheduleInput = {
    name: patch.name ?? current.name,
    timezone: patch.timezone ?? current.timezone,
    rotationDays: patch.rotationDays ?? current.rotationDays,
    handoffTime: patch.handoffTime ?? current.handoffTime,
    startDate: patch.startDate ?? current.startDate,
    participantUserIds:
      patch.participantUserIds ?? current.participants.map((person) => person.userId),
    enabled: patch.enabled ?? current.enabled,
  };
  const problem = validateOnCallSchedule(merged);
  if (problem) throw new OnCallInputError(problem);

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(onCallSchedules)
        .set({
          name: merged.name.trim(),
          timezone: merged.timezone,
          rotationDays: merged.rotationDays,
          handoffTime: merged.handoffTime,
          startDate: merged.startDate,
          enabled: merged.enabled ?? true,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(onCallSchedules.organizationId, organizationId),
            eq(onCallSchedules.id, scheduleId),
          ),
        );
      if (patch.participantUserIds) {
        await replaceParticipants(tx, scheduleId, merged.participantUserIds);
      }
    });
  } catch (err) {
    throw asConflict(err, merged.name.trim());
  }

  const updated = await getOnCallSchedule(organizationId, scheduleId);
  if (!updated) throw new OnCallInputError("No such rotation.", 404);
  return updated;
}

export async function deleteOnCallSchedule(
  organizationId: string,
  scheduleId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(onCallSchedules)
    .where(
      and(eq(onCallSchedules.organizationId, organizationId), eq(onCallSchedules.id, scheduleId)),
    )
    .returning({ id: onCallSchedules.id });
  return deleted.length > 0;
}

function asConflict(err: unknown, name: string): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("on_call_schedules_org_name_unique")) {
    return new OnCallInputError(`A rotation called "${name}" already exists.`, 409);
  }
  if (message.includes("on_call_participants_schedule_user_unique")) {
    return new OnCallInputError("Each person may appear in the rotation once.", 409);
  }
  return err;
}

// ---------------------------------------------------------------------------
// Covers
// ---------------------------------------------------------------------------

export async function listOnCallOverrides(
  organizationId: string,
  options: { scheduleId?: string | undefined; from?: Date | undefined; to?: Date | undefined } = {},
): Promise<OnCallOverride[]> {
  const filters = [eq(onCallOverrides.organizationId, organizationId)];
  if (options.scheduleId) filters.push(eq(onCallOverrides.scheduleId, options.scheduleId));
  // A cover overlaps the window when it starts before the window ends and ends
  // after it starts — not when both endpoints are inside it.
  if (options.to) filters.push(lte(onCallOverrides.startsAt, options.to));
  if (options.from) filters.push(gte(onCallOverrides.endsAt, options.from));

  const rows = await db
    .select({
      id: onCallOverrides.id,
      scheduleId: onCallOverrides.scheduleId,
      userId: onCallOverrides.userId,
      userName: users.displayName,
      startsAt: onCallOverrides.startsAt,
      endsAt: onCallOverrides.endsAt,
      reason: onCallOverrides.reason,
      createdByUserId: onCallOverrides.createdByUserId,
      createdAt: onCallOverrides.createdAt,
    })
    .from(onCallOverrides)
    .leftJoin(users, eq(users.id, onCallOverrides.userId))
    .where(and(...filters))
    .orderBy(asc(onCallOverrides.startsAt));

  return rows.map((row) => ({
    id: row.id,
    scheduleId: row.scheduleId,
    userId: row.userId,
    userName: row.userName,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  }));
}

export interface CreateOverrideInput {
  scheduleId: string;
  userId: string;
  startsAt: string;
  endsAt: string;
  reason?: string | null;
}

export async function createOnCallOverride(
  organizationId: string,
  input: CreateOverrideInput,
  createdByUserId: string | null,
): Promise<OnCallOverride> {
  const problem = validateOnCallOverride(input);
  if (problem) throw new OnCallInputError(problem);

  const schedule = await getOnCallSchedule(organizationId, input.scheduleId);
  if (!schedule) throw new OnCallInputError("No such rotation.", 404);

  const id = randomUUID();
  await db.insert(onCallOverrides).values({
    id,
    organizationId,
    scheduleId: input.scheduleId,
    userId: input.userId,
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    reason: input.reason?.trim() || null,
    createdByUserId,
  });

  const created = (
    await listOnCallOverrides(organizationId, { scheduleId: input.scheduleId })
  ).find((row) => row.id === id);
  if (!created) throw new Error("Failed to create the cover");
  return created;
}

export async function deleteOnCallOverride(
  organizationId: string,
  overrideId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(onCallOverrides)
    .where(
      and(eq(onCallOverrides.organizationId, organizationId), eq(onCallOverrides.id, overrideId)),
    )
    .returning({ id: onCallOverrides.id });
  return deleted.length > 0;
}

// ---------------------------------------------------------------------------
// Resolve — what the alert path calls
// ---------------------------------------------------------------------------

export interface ResolvedOnCall {
  shift: OnCallShift | null;
  /** The next person in the rotation, for escalation. Never a cover. */
  next: OnCallParticipant | null;
}

/**
 * Who to wake for one schedule, right now.
 *
 * Never throws and never rejects: it is called on the alert delivery path, and
 * an alert lost because a rotation was misconfigured — or because this query
 * failed — is strictly worse than an alert delivered to the rule's other
 * destinations without the on-call leg. Failure is logged and returns nobody.
 */
export async function resolveOnCallNow(
  organizationId: string,
  scheduleId: string,
  atMs = Date.now(),
): Promise<ResolvedOnCall> {
  try {
    const schedule = await getOnCallSchedule(organizationId, scheduleId);
    if (!schedule) return { shift: null, next: null };
    // Only covers that could possibly be live are read; the window is one
    // instant, so the index on (schedule, startsAt, endsAt) does the work.
    const overrides = await listOnCallOverrides(organizationId, {
      scheduleId,
      from: new Date(atMs),
      to: new Date(atMs),
    });
    return {
      shift: resolveOnCall(schedule, overrides, atMs),
      next: nextOnCall(schedule, atMs),
    };
  } catch (err) {
    console.error(`[on-call] failed to resolve schedule ${scheduleId}:`, err);
    return { shift: null, next: null };
  }
}
