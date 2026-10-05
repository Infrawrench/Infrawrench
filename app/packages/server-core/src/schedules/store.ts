/**
 * Sleep/wake schedule rows: CRUD + normalization shared by the web API, the
 * MCP tools and the poller pass.
 *
 * Timing validation and next-transition computation come from
 * `@infrawrench/client-core` (`validateScheduleTiming`,
 * `computeNextTransition`), the same functions the editor UIs preview with:
 * the server and the form can't disagree about when a window opens.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  computeNextTransition,
  validateScheduleTiming,
  SCHEDULE_LIMITS,
  type ScheduleAction,
  type ScheduleRunStatus,
  type SleepScheduleTiming,
} from "@infrawrench/client-core";
import type { LifecycleActionsDeclaration } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { resourceSchedules, resources } from "../db/schema";
import { getPlugin } from "../plugin-loader";
import { captureScheduleSaving, endScheduleSaving } from "../savings/capture";

export interface ScheduleRecord {
  id: string;
  organizationId: string;
  accountId: string;
  resourceId: string;
  pluginId: string;
  resourceTypeId: string;
  daysOfWeek: number[];
  stopTime: string;
  startTime: string;
  timezone: string;
  paused: boolean;
  nextTransitionAt: Date | null;
  nextTransitionAction: ScheduleAction | null;
  lastTransitionKey: string | null;
  lastRunAt: Date | null;
  lastRunAction: ScheduleAction | null;
  lastRunStatus: ScheduleRunStatus | null;
  lastRunError: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScheduleCreateInput extends SleepScheduleTiming {
  resourceId: string;
  accountId: string;
}

export interface ScheduleUpdateInput {
  daysOfWeek?: number[];
  stopTime?: string;
  startTime?: string;
  timezone?: string;
  paused?: boolean;
}

/** Thrown for caller mistakes the API maps to 400/404/409. */
export class ScheduleInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ScheduleInputError";
  }
}

/** The `lifecycle` declaration for a type, or null when it has none. */
export async function lifecycleForType(
  pluginId: string,
  resourceTypeId: string,
): Promise<LifecycleActionsDeclaration | null> {
  const loaded = await getPlugin(pluginId);
  const type = loaded?.plugin.resourceTypes.find((rt) => rt.id === resourceTypeId);
  return type?.lifecycle ?? null;
}

function timingOf(row: ScheduleRecord): SleepScheduleTiming {
  return {
    daysOfWeek: row.daysOfWeek,
    stopTime: row.stopTime,
    startTime: row.startTime,
    timezone: row.timezone,
  };
}

/** Next transition columns for a row's timing: null while paused. */
export function nextTransitionColumns(
  timing: SleepScheduleTiming,
  paused: boolean,
  now?: number,
): { nextTransitionAt: Date | null; nextTransitionAction: ScheduleAction | null } {
  if (paused) return { nextTransitionAt: null, nextTransitionAction: null };
  const next = computeNextTransition(timing, now);
  return next
    ? { nextTransitionAt: new Date(next.at), nextTransitionAction: next.action }
    : { nextTransitionAt: null, nextTransitionAction: null };
}

export async function listScheduleRecords(organizationId: string): Promise<ScheduleRecord[]> {
  const rows = await db
    .select()
    .from(resourceSchedules)
    .where(eq(resourceSchedules.organizationId, organizationId))
    .orderBy(resourceSchedules.createdAt);
  return rows as ScheduleRecord[];
}

export async function getScheduleRecord(
  organizationId: string,
  scheduleId: string,
): Promise<ScheduleRecord | null> {
  const rows = await db
    .select()
    .from(resourceSchedules)
    .where(
      and(
        eq(resourceSchedules.organizationId, organizationId),
        eq(resourceSchedules.id, scheduleId),
      ),
    )
    .limit(1);
  return (rows[0] as ScheduleRecord | undefined) ?? null;
}

/**
 * Create a schedule for a synced resource. Validates the timing, that the
 * resource exists in this org and account, and that its type declares a
 * lifecycle start/stop pair: eligibility is discovered from the plugin's
 * declaration, never from provider names.
 */
export async function createScheduleRecord(
  organizationId: string,
  input: ScheduleCreateInput,
  createdByUserId?: string,
): Promise<ScheduleRecord> {
  const timingError = validateScheduleTiming(input);
  if (timingError) throw new ScheduleInputError(timingError);

  const [resource] = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      deletedAt: resources.deletedAt,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), eq(resources.id, input.resourceId)))
    .limit(1);
  if (!resource || resource.deletedAt !== null) {
    throw new ScheduleInputError("Resource not found in this organization", 404);
  }
  if (resource.accountId !== input.accountId) {
    throw new ScheduleInputError("Resource does not belong to that account");
  }

  const lifecycle = await lifecycleForType(resource.pluginId, resource.resourceTypeId);
  if (!lifecycle) {
    throw new ScheduleInputError(
      "This resource type declares no start/stop lifecycle actions, so it cannot be scheduled",
    );
  }

  const now = new Date();
  const row = {
    id: randomUUID(),
    organizationId,
    accountId: resource.accountId,
    resourceId: resource.id,
    pluginId: resource.pluginId,
    resourceTypeId: resource.resourceTypeId,
    daysOfWeek: [...input.daysOfWeek].sort((a, b) => a - b),
    stopTime: input.stopTime,
    startTime: input.startTime,
    timezone: input.timezone,
    paused: false,
    ...nextTransitionColumns(input, false),
    createdByUserId: createdByUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  // The duplicate check, the per-org limit and the insert run in one
  // transaction under an org-scoped advisory lock, so two concurrent creates
  // can't both pass the checks. The unique index on (organization_id,
  // resource_id) is the hard backstop: a conflict from it surfaces as the
  // same 409 the pre-check gives, never as a raw database error.
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`resource_schedules:${organizationId}`}))`,
      );
      const existing = await tx
        .select({ id: resourceSchedules.id })
        .from(resourceSchedules)
        .where(
          and(
            eq(resourceSchedules.organizationId, organizationId),
            eq(resourceSchedules.resourceId, input.resourceId),
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        throw new ScheduleInputError("This resource already has a schedule, edit it instead", 409);
      }

      const count = await tx
        .select({ id: resourceSchedules.id })
        .from(resourceSchedules)
        .where(eq(resourceSchedules.organizationId, organizationId));
      if (count.length >= SCHEDULE_LIMITS.maxPerOrg) {
        throw new ScheduleInputError(
          `Organizations are limited to ${SCHEDULE_LIMITS.maxPerOrg} schedules`,
        );
      }

      await tx.insert(resourceSchedules).values(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ScheduleInputError("This resource already has a schedule, edit it instead", 409);
    }
    throw error;
  }
  const created = (await getScheduleRecord(organizationId, row.id))!;
  // A schedule in force is a recurring saving; never throws.
  await captureScheduleSaving(created, createdByUserId ?? null);
  return created;
}

/**
 * Update timing and/or the pause toggle. Any change recomputes the next
 * transition; pausing clears it (nothing is due while paused), unpausing
 * schedules from now. The idempotency key is cleared on timing edits so the
 * new window's first transition is never mistaken for one that already ran.
 */
export async function updateScheduleRecord(
  organizationId: string,
  scheduleId: string,
  patch: ScheduleUpdateInput,
): Promise<ScheduleRecord> {
  const existing = await getScheduleRecord(organizationId, scheduleId);
  if (!existing) throw new ScheduleInputError("Schedule not found", 404);

  const timingChanged =
    patch.daysOfWeek !== undefined ||
    patch.stopTime !== undefined ||
    patch.startTime !== undefined ||
    patch.timezone !== undefined;

  const timing: SleepScheduleTiming = {
    daysOfWeek: patch.daysOfWeek ?? existing.daysOfWeek,
    stopTime: patch.stopTime ?? existing.stopTime,
    startTime: patch.startTime ?? existing.startTime,
    timezone: patch.timezone ?? existing.timezone,
  };
  const timingError = validateScheduleTiming(timing);
  if (timingError) throw new ScheduleInputError(timingError);

  const paused = patch.paused ?? existing.paused;
  await db
    .update(resourceSchedules)
    .set({
      daysOfWeek: [...timing.daysOfWeek].sort((a, b) => a - b),
      stopTime: timing.stopTime,
      startTime: timing.startTime,
      timezone: timing.timezone,
      paused,
      ...nextTransitionColumns(timing, paused),
      ...(timingChanged ? { lastTransitionKey: null } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resourceSchedules.organizationId, organizationId),
        eq(resourceSchedules.id, scheduleId),
      ),
    );
  const updated = (await getScheduleRecord(organizationId, scheduleId))!;

  // Realized savings: a stretch of the schedule in force is one event. A
  // pause or a retime ends the open stretch; a resume or a retime opens the
  // next one, so each stretch's estimate describes the timing actually run.
  const retimed =
    timingChanged &&
    (updated.stopTime !== existing.stopTime ||
      updated.startTime !== existing.startTime ||
      updated.timezone !== existing.timezone ||
      updated.daysOfWeek.join(",") !== existing.daysOfWeek.join(","));
  if (paused && !existing.paused) {
    await endScheduleSaving(organizationId, scheduleId);
  } else if (!paused && (existing.paused || retimed)) {
    if (retimed) await endScheduleSaving(organizationId, scheduleId);
    await captureScheduleSaving(updated);
  }
  return updated;
}

export async function deleteScheduleRecord(
  organizationId: string,
  scheduleId: string,
): Promise<ScheduleRecord> {
  const existing = await getScheduleRecord(organizationId, scheduleId);
  if (!existing) throw new ScheduleInputError("Schedule not found", 404);
  await db
    .delete(resourceSchedules)
    .where(
      and(
        eq(resourceSchedules.organizationId, organizationId),
        eq(resourceSchedules.id, scheduleId),
      ),
    );
  // The saving it delivered while it ran stays on the books; it stops here.
  await endScheduleSaving(organizationId, scheduleId);
  return existing;
}

export { timingOf as scheduleTiming };
