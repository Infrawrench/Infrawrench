/**
 * Automatic restore drills: which resources can be drilled, the schedules, and
 * the run history.
 *
 * A resource can be drilled when the backup coverage feed says something
 * protects it (the same population the manual drill list uses) **and** its
 * plugin declares `manifest.restoreDrill` for its type. Both come from data
 * this process already has (the synced inventory and the plugin manifests), so
 * nothing here calls a provider and every read works on the edge. The runs
 * themselves happen in the poller (`drill-pass.ts`).
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import {
  DRILL_SCHEDULE_LIMITS,
  validateDrillSchedule,
  type DrillRestorePointKind,
  type RestoreDrillRun,
  type RestoreDrillSchedule,
  type RestoreDrillScheduleInput,
  type RestoreDrillTargetRow,
} from "@infrawrench/client-core";
import { restoreDrillCopyName } from "@infrawrench/plugin-base";

import { db } from "../db/client";
import { restoreDrillRuns, restoreDrillSchedules } from "../db/restore-drill-schedule-schema";
import { loadPlugins } from "../plugin-loader";
import { listBackupCoverage } from "./feed";

export class DrillScheduleInputError extends Error {
  status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = "DrillScheduleInputError";
    this.status = status;
  }
}

/**
 * Every resource the org could schedule an automatic drill for, with what its
 * provider can do. The picker in both UIs is built from this, so nobody types
 * an id.
 */
export async function listDrillTargets(organizationId: string): Promise<RestoreDrillTargetRow[]> {
  const [coverage, plugins] = await Promise.all([
    listBackupCoverage(organizationId),
    loadPlugins(),
  ]);
  const declarations = new Map(
    plugins.flatMap(({ plugin }) => {
      const drill = plugin.manifest.restoreDrill;
      return drill ? [[plugin.manifest.id, drill] as const] : [];
    }),
  );
  const rows: RestoreDrillTargetRow[] = [];
  for (const resource of coverage.resources) {
    // Only resources with something to restore from, as the manual list.
    if (resource.state !== "protected" && resource.state !== "automated") continue;
    const drill = declarations.get(resource.pluginId);
    const target = drill?.targets.find((t) => t.resourceTypeId === resource.resourceTypeId);
    if (!drill || !target) continue;
    rows.push({
      resourceId: resource.resourceId,
      resourceName: resource.displayName,
      resourceTypeId: resource.resourceTypeId,
      resourceTypeName: resource.resourceTypeName,
      accountId: resource.accountId,
      accountName: resource.accountName,
      pluginId: resource.pluginId,
      pluginName: resource.pluginName,
      copyNoun: drill.copyNoun,
      restorePoints: [...target.restorePoints],
      maxLookbackHours: target.maxLookbackHours ?? null,
      typicalReadyMinutes: target.typicalReadyMinutes ?? null,
      costSummary: drill.cost?.summary ?? null,
      costUrl: drill.cost?.url ?? null,
    });
  }
  return rows;
}

type ScheduleRow = typeof restoreDrillSchedules.$inferSelect;
type RunRow = typeof restoreDrillRuns.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function runToWire(row: RunRow): RestoreDrillRun {
  const rpoMinutes =
    row.restorePointAt === null
      ? null
      : Math.max(0, Math.round((row.startedAt.getTime() - row.restorePointAt.getTime()) / 60_000));
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    resourceId: row.resourceId,
    trigger: row.trigger,
    state: row.state,
    outcome: row.outcome,
    copyName: row.copyName,
    restoredFrom: row.restoredFrom,
    restorePointAt: iso(row.restorePointAt),
    startedAt: row.startedAt.toISOString(),
    readyAt: iso(row.readyAt),
    finishedAt: iso(row.finishedAt),
    deadlineAt: row.deadlineAt.toISOString(),
    restoreSeconds: row.restoreSeconds,
    rpoMinutes,
    verifyValue: row.verifyValue,
    detail: row.detail,
    cleanupState: row.cleanupState,
    cleanupError: row.cleanupError,
    cleanupAttempts: row.cleanupAttempts,
    restoreDrillId: row.restoreDrillId,
  };
}

function scheduleToWire(
  row: ScheduleRow,
  names: Map<string, { resourceName: string; accountName: string }>,
  lastRun: RunRow | undefined,
): RestoreDrillSchedule {
  const named = names.get(row.resourceId);
  return {
    id: row.id,
    resourceId: row.resourceId,
    resourceName: named?.resourceName ?? null,
    accountId: row.accountId,
    accountName: named?.accountName ?? null,
    resourceTypeId: row.resourceTypeId,
    pluginId: row.pluginId,
    intervalDays: row.intervalDays,
    restorePoint: row.restorePoint,
    pointInTimeHoursAgo: row.pointInTimeHoursAgo,
    verifySql: row.verifySql,
    verifyMode: row.verifyMode,
    verifyOperator: row.verifyOperator,
    verifyThreshold: row.verifyThreshold,
    timeLimitMinutes: row.timeLimitMinutes,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt.toISOString(),
    lastRun: lastRun ? runToWire(lastRun) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The newest run of each schedule, one query. */
async function latestRuns(organizationId: string, scheduleIds: string[]) {
  if (scheduleIds.length === 0) return new Map<string, RunRow>();
  const rows = await db
    .selectDistinctOn([restoreDrillRuns.scheduleId])
    .from(restoreDrillRuns)
    .where(
      and(
        eq(restoreDrillRuns.organizationId, organizationId),
        inArray(restoreDrillRuns.scheduleId, scheduleIds),
      ),
    )
    .orderBy(restoreDrillRuns.scheduleId, desc(restoreDrillRuns.startedAt));
  return new Map(rows.flatMap((row) => (row.scheduleId ? [[row.scheduleId, row] as const] : [])));
}

export async function listDrillSchedules(organizationId: string): Promise<RestoreDrillSchedule[]> {
  const rows = await db
    .select()
    .from(restoreDrillSchedules)
    .where(eq(restoreDrillSchedules.organizationId, organizationId))
    .orderBy(desc(restoreDrillSchedules.createdAt));
  if (rows.length === 0) return [];
  const [coverage, runs] = await Promise.all([
    listBackupCoverage(organizationId),
    latestRuns(
      organizationId,
      rows.map((r) => r.id),
    ),
  ]);
  const names = new Map(
    coverage.resources.map((r) => [
      r.resourceId,
      { resourceName: r.displayName, accountName: r.accountName },
    ]),
  );
  return rows.map((row) => scheduleToWire(row, names, runs.get(row.id)));
}

async function getScheduleRow(organizationId: string, scheduleId: string) {
  const [row] = await db
    .select()
    .from(restoreDrillSchedules)
    .where(
      and(
        eq(restoreDrillSchedules.organizationId, organizationId),
        eq(restoreDrillSchedules.id, scheduleId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function getSchedule(organizationId: string, scheduleId: string) {
  const all = await listDrillSchedules(organizationId);
  const found = all.find((s) => s.id === scheduleId);
  if (!found) throw new DrillScheduleInputError("No such drill schedule.", 404);
  return found;
}

function normalize(input: RestoreDrillScheduleInput) {
  const sql = input.verifySql?.trim() || null;
  return {
    intervalDays: input.intervalDays,
    restorePoint: input.restorePoint,
    pointInTimeHoursAgo:
      input.restorePoint === "point-in-time" ? (input.pointInTimeHoursAgo ?? 0) : null,
    verifySql: sql,
    verifyMode: input.verifyMode ?? "rowCount",
    verifyOperator: input.verifyOperator ?? "gt",
    verifyThreshold: input.verifyThreshold ?? 0,
    timeLimitMinutes: input.timeLimitMinutes,
    enabled: input.enabled ?? true,
  };
}

export async function createDrillSchedule(
  organizationId: string,
  input: RestoreDrillScheduleInput,
  userId: string | null,
): Promise<RestoreDrillSchedule> {
  const target = (await listDrillTargets(organizationId)).find(
    (t) => t.resourceId === input.resourceId,
  );
  if (!target) {
    throw new DrillScheduleInputError(
      "That resource cannot be drilled automatically: its provider has no isolated copies, or nothing backs it up.",
      404,
    );
  }
  const problem = validateDrillSchedule(input, target);
  if (problem) throw new DrillScheduleInputError(problem);

  const existing = await db
    .select({ id: restoreDrillSchedules.id, resourceId: restoreDrillSchedules.resourceId })
    .from(restoreDrillSchedules)
    .where(eq(restoreDrillSchedules.organizationId, organizationId));
  if (existing.some((row) => row.resourceId === input.resourceId)) {
    throw new DrillScheduleInputError("This resource already has a drill schedule.", 409);
  }
  if (existing.length >= DRILL_SCHEDULE_LIMITS.maxPerOrg) {
    throw new DrillScheduleInputError(
      `An organization can have at most ${DRILL_SCHEDULE_LIMITS.maxPerOrg} drill schedules.`,
      409,
    );
  }

  const id = randomUUID();
  await db.insert(restoreDrillSchedules).values({
    id,
    organizationId,
    accountId: target.accountId,
    resourceId: target.resourceId,
    resourceTypeId: target.resourceTypeId,
    pluginId: target.pluginId,
    ...normalize(input),
    // The first run is one interval out: scheduling a drill is not a request to
    // run one now, which is what "Run now" is for.
    nextRunAt: new Date(Date.now() + input.intervalDays * 86_400_000),
    createdByUserId: userId,
  });
  return getSchedule(organizationId, id);
}

export async function updateDrillSchedule(
  organizationId: string,
  scheduleId: string,
  patch: Partial<Omit<RestoreDrillScheduleInput, "resourceId">>,
): Promise<RestoreDrillSchedule> {
  const row = await getScheduleRow(organizationId, scheduleId);
  if (!row) throw new DrillScheduleInputError("No such drill schedule.", 404);
  const merged: RestoreDrillScheduleInput = {
    resourceId: row.resourceId,
    intervalDays: patch.intervalDays ?? row.intervalDays,
    restorePoint: patch.restorePoint ?? row.restorePoint,
    pointInTimeHoursAgo:
      patch.pointInTimeHoursAgo !== undefined
        ? patch.pointInTimeHoursAgo
        : (patch.restorePoint ?? row.restorePoint) === "point-in-time"
          ? row.pointInTimeHoursAgo
          : null,
    verifySql: patch.verifySql !== undefined ? patch.verifySql : row.verifySql,
    verifyMode: patch.verifyMode ?? row.verifyMode,
    verifyOperator: patch.verifyOperator ?? row.verifyOperator,
    verifyThreshold: patch.verifyThreshold ?? row.verifyThreshold,
    timeLimitMinutes: patch.timeLimitMinutes ?? row.timeLimitMinutes,
    enabled: patch.enabled ?? row.enabled,
  };
  const target =
    (await listDrillTargets(organizationId)).find((t) => t.resourceId === row.resourceId) ?? null;
  const problem = validateDrillSchedule(merged, target);
  if (problem) throw new DrillScheduleInputError(problem);

  const intervalChanged = merged.intervalDays !== row.intervalDays;
  const resumed = merged.enabled === true && !row.enabled;
  await db
    .update(restoreDrillSchedules)
    .set({
      ...normalize(merged),
      ...(intervalChanged || resumed
        ? { nextRunAt: new Date(Date.now() + merged.intervalDays * 86_400_000) }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(restoreDrillSchedules.id, row.id));
  return getSchedule(organizationId, scheduleId);
}

/**
 * Delete a schedule. A run already in flight keeps going to its end, cleanup
 * included: dropping it here would strand the copy it made.
 */
export async function deleteDrillSchedule(
  organizationId: string,
  scheduleId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(restoreDrillSchedules)
    .where(
      and(
        eq(restoreDrillSchedules.organizationId, organizationId),
        eq(restoreDrillSchedules.id, scheduleId),
      ),
    )
    .returning({ id: restoreDrillSchedules.id });
  return deleted.length > 0;
}

/** Runs that have not finished; a run holding a copy stays in `cleaning` until it is gone. */
const unfinished = () => notInArray(restoreDrillRuns.state, ["done"]);

/**
 * Queue a run of one schedule now. The pass starts it on its next tick. A
 * schedule runs one drill at a time: a second copy of the same database while
 * the first is still up is cost with nothing to learn from it.
 */
export async function startDrillRunNow(
  organizationId: string,
  scheduleId: string,
  userId: string | null,
): Promise<RestoreDrillRun> {
  const row = await getScheduleRow(organizationId, scheduleId);
  if (!row) throw new DrillScheduleInputError("No such drill schedule.", 404);
  const [active] = await db
    .select({ id: restoreDrillRuns.id })
    .from(restoreDrillRuns)
    .where(
      and(
        eq(restoreDrillRuns.organizationId, organizationId),
        eq(restoreDrillRuns.scheduleId, scheduleId),
        unfinished(),
      ),
    )
    .limit(1);
  if (active)
    throw new DrillScheduleInputError("A drill of this resource is already running.", 409);
  const run = await insertRun(row, "manual", userId);
  return runToWire(run);
}

/** A new run row from a schedule, snapshotting its settings. Shared with the pass. */
export async function insertRun(
  schedule: ScheduleRow,
  trigger: "schedule" | "manual",
  userId: string | null,
): Promise<RunRow> {
  const id = randomUUID();
  const now = new Date();
  const restorePoint: DrillRestorePointKind = schedule.restorePoint;
  const [row] = await db
    .insert(restoreDrillRuns)
    .values({
      id,
      organizationId: schedule.organizationId,
      scheduleId: schedule.id,
      accountId: schedule.accountId,
      resourceId: schedule.resourceId,
      resourceTypeId: schedule.resourceTypeId,
      trigger,
      state: "starting",
      restorePoint,
      pointInTimeAt:
        restorePoint === "point-in-time"
          ? new Date(now.getTime() - (schedule.pointInTimeHoursAgo ?? 0) * 3_600_000)
          : null,
      verifySql: schedule.verifySql,
      verifyMode: schedule.verifyMode,
      verifyOperator: schedule.verifyOperator,
      verifyThreshold: schedule.verifyThreshold,
      copyName: restoreDrillCopyName(id),
      startedAt: now,
      deadlineAt: new Date(now.getTime() + schedule.timeLimitMinutes * 60_000),
      nextStepAt: now,
      createdByUserId: userId,
    })
    .returning();
  if (!row) throw new Error("Failed to queue the drill run");
  return row;
}

export async function listDrillRuns(
  organizationId: string,
  options: { scheduleId?: string | undefined; limit?: number | undefined } = {},
): Promise<RestoreDrillRun[]> {
  const filters = [eq(restoreDrillRuns.organizationId, organizationId)];
  if (options.scheduleId) filters.push(eq(restoreDrillRuns.scheduleId, options.scheduleId));
  const rows = await db
    .select()
    .from(restoreDrillRuns)
    .where(and(...filters))
    .orderBy(desc(restoreDrillRuns.startedAt))
    .limit(Math.min(options.limit ?? 50, 200));
  return rows.map(runToWire);
}
