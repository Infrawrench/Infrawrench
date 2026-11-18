/**
 * Automatic restore drills: a schedule that copies a database from a restore
 * point into an isolated branch, fork or database, optionally checks what came
 * back with a read-only query, and deletes the copy again.
 *
 * The manual drill log (`restore-drills.ts`) stays the single record of what
 * was tested. An automatic run writes into that same log, as "Restored and
 * checked" when its query holds, so coverage, compliance evidence and anything
 * else reading drills cannot tell, and does not need to tell, who ran it.
 *
 * Only providers whose copies are isolated from the source and cheap to throw
 * away offer this (the plugin manifest's `restoreDrill`); for everything else
 * the reasoning in `restore-drills.ts` still holds and drills stay manual.
 *
 * This module is the pure half: shapes, validation, the verification verdict
 * and the clock arithmetic, shared by the server, the pass and both UIs.
 */
import {
  QUERY_MONITOR_LIMITS,
  QUERY_MONITOR_OPERATOR_LABELS,
  breaches,
  monitorSqlProblem,
  type QueryMonitorMode,
  type QueryMonitorOperator,
} from "./query-monitors";

/** Where a drill restores from. Mirrors plugin-base's `RestoreDrillPointKind`. */
export type DrillRestorePointKind = "latest-backup" | "point-in-time";

export const DRILL_RESTORE_POINT_KINDS: readonly DrillRestorePointKind[] = [
  "latest-backup",
  "point-in-time",
];

export const DRILL_SCHEDULE_LIMITS = {
  minIntervalDays: 1,
  maxIntervalDays: 365,
  defaultIntervalDays: 30,
  /** The copy is deleted once this passes, ready or not. */
  minTimeLimitMinutes: 5,
  maxTimeLimitMinutes: 720,
  defaultTimeLimitMinutes: 60,
  /** Offset from now for a point-in-time copy, in hours. 0 means "now". */
  maxPointInTimeHoursAgo: 24 * 35,
  maxSqlLength: QUERY_MONITOR_LIMITS.maxSqlLength,
  maxPerOrg: 100,
} as const;

/** Intervals the picker offers; the API accepts any whole number of days in range. */
export const DRILL_INTERVAL_PRESETS = [1, 7, 14, 30, 90] as const;

/** One resource that can be drilled automatically: what the schedule picker offers. */
export interface RestoreDrillTargetRow {
  resourceId: string;
  resourceName: string;
  resourceTypeId: string;
  resourceTypeName: string;
  accountId: string;
  accountName: string;
  pluginId: string;
  pluginName: string;
  /** The provider's word for the copy: "branch", "fork", "database". */
  copyNoun: string;
  restorePoints: DrillRestorePointKind[];
  maxLookbackHours: number | null;
  typicalReadyMinutes: number | null;
  costSummary: string | null;
  costUrl: string | null;
}

export interface RestoreDrillScheduleInput {
  resourceId: string;
  intervalDays: number;
  restorePoint: DrillRestorePointKind;
  /** Point-in-time only: how many hours before the run to restore to. */
  pointInTimeHoursAgo?: number | null;
  /** Read-only query run against the copy. Null means restore without checking. */
  verifySql?: string | null;
  verifyMode?: QueryMonitorMode;
  verifyOperator?: QueryMonitorOperator;
  verifyThreshold?: number;
  timeLimitMinutes: number;
  enabled?: boolean;
}

export type DrillRunState = "starting" | "restoring" | "cleaning" | "done";

/**
 * Where deleting the copy stands. `failed` means at least one attempt failed
 * and the pass is still retrying; it only becomes `done` once the provider
 * confirms the copy is gone.
 */
export type DrillCleanupState = "none" | "pending" | "failed" | "done";

export type DrillRunOutcome = "verified" | "restored-unverified" | "failed";

export interface RestoreDrillRun {
  id: string;
  scheduleId: string | null;
  resourceId: string;
  trigger: "schedule" | "manual";
  state: DrillRunState;
  outcome: DrillRunOutcome | null;
  copyName: string;
  restoredFrom: string | null;
  restorePointAt: string | null;
  startedAt: string;
  readyAt: string | null;
  finishedAt: string | null;
  deadlineAt: string;
  /** Seconds from asking for the copy to it taking connections. */
  restoreSeconds: number | null;
  /** Minutes between the restore point and the start of the run. */
  rpoMinutes: number | null;
  verifyValue: number | null;
  /** What happened, in a sentence: the check, the provider's error, the timeout. */
  detail: string | null;
  cleanupState: DrillCleanupState;
  cleanupError: string | null;
  cleanupAttempts: number;
  /** The drill record this run wrote, once it reached an outcome. */
  restoreDrillId: string | null;
}

export interface RestoreDrillSchedule {
  id: string;
  resourceId: string;
  resourceName: string | null;
  accountId: string;
  accountName: string | null;
  resourceTypeId: string;
  pluginId: string;
  intervalDays: number;
  restorePoint: DrillRestorePointKind;
  pointInTimeHoursAgo: number | null;
  verifySql: string | null;
  verifyMode: QueryMonitorMode;
  verifyOperator: QueryMonitorOperator;
  verifyThreshold: number;
  timeLimitMinutes: number;
  enabled: boolean;
  nextRunAt: string;
  lastRun: RestoreDrillRun | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Validate a schedule as the form and the API both see it. `target` is the
 * drill target the resource resolved to, when known, so the restore point is
 * checked against what the provider can actually do.
 */
export function validateDrillSchedule(
  input: RestoreDrillScheduleInput,
  target?: Pick<RestoreDrillTargetRow, "restorePoints" | "maxLookbackHours"> | null,
): string | null {
  if (!input.resourceId) return "Choose the resource to drill.";
  const L = DRILL_SCHEDULE_LIMITS;
  if (
    !Number.isInteger(input.intervalDays) ||
    input.intervalDays < L.minIntervalDays ||
    input.intervalDays > L.maxIntervalDays
  ) {
    return `Run every ${L.minIntervalDays} to ${L.maxIntervalDays} days.`;
  }
  if (!DRILL_RESTORE_POINT_KINDS.includes(input.restorePoint)) return "Choose a restore point.";
  if (target && !target.restorePoints.includes(input.restorePoint)) {
    return "This provider cannot restore from that point.";
  }
  if (input.restorePoint === "point-in-time") {
    const hours = input.pointInTimeHoursAgo ?? 0;
    const max = Math.min(L.maxPointInTimeHoursAgo, target?.maxLookbackHours ?? Infinity);
    if (!Number.isInteger(hours) || hours < 0 || hours > max) {
      return `Restore to between 0 and ${max} hours ago.`;
    }
  } else if (input.pointInTimeHoursAgo != null) {
    return "Only a point-in-time drill takes an offset.";
  }
  if (
    !Number.isInteger(input.timeLimitMinutes) ||
    input.timeLimitMinutes < L.minTimeLimitMinutes ||
    input.timeLimitMinutes > L.maxTimeLimitMinutes
  ) {
    return `The time limit must be between ${L.minTimeLimitMinutes} and ${L.maxTimeLimitMinutes} minutes.`;
  }
  const sql = input.verifySql?.trim() ?? "";
  if (sql) {
    if (sql.length > L.maxSqlLength) {
      return `The check must be ${L.maxSqlLength} characters or fewer.`;
    }
    const problem = monitorSqlProblem(sql);
    if (problem) return problem;
    if (input.verifyThreshold !== undefined && !Number.isFinite(input.verifyThreshold)) {
      return "The expected value must be a number.";
    }
  }
  return null;
}

/** "row count > 0", "value ≥ 1000": the condition a check expects, for a sentence. */
export function describeDrillCheck(check: {
  verifyMode: QueryMonitorMode;
  verifyOperator: QueryMonitorOperator;
  verifyThreshold: number;
}): string {
  const subject = check.verifyMode === "rowCount" ? "row count" : "value";
  return `${subject} ${QUERY_MONITOR_OPERATOR_LABELS[check.verifyOperator]} ${check.verifyThreshold}`;
}

/**
 * The verdict on a check. A query that errored or returned nothing readable
 * never passes: a check that could not run proves nothing about the data.
 */
export function drillCheckVerdict(
  check: {
    verifyMode: QueryMonitorMode;
    verifyOperator: QueryMonitorOperator;
    verifyThreshold: number;
  },
  result: { value: number | null; error: string | null },
): { passed: boolean; detail: string } {
  const expected = describeDrillCheck(check);
  if (result.error) return { passed: false, detail: `The check could not run: ${result.error}` };
  if (result.value === null) {
    return { passed: false, detail: `The check returned no number; expected ${expected}.` };
  }
  const passed = breaches(result.value, check.verifyOperator, check.verifyThreshold);
  return {
    passed,
    detail: passed
      ? `Checked: ${expected} (got ${result.value}).`
      : `The check did not hold: expected ${expected}, got ${result.value}.`,
  };
}

/** Whole minutes for the drill log, never zero for a copy that took any time. */
export function drillRtoMinutes(restoreSeconds: number): number {
  return Math.max(1, Math.ceil(restoreSeconds / 60));
}

/** Minutes between a restore point and the run that restored it; null when unknown. */
export function drillRpoMinutes(restorePointAt: string | null, startedAt: string): number | null {
  if (!restorePointAt) return null;
  const point = Date.parse(restorePointAt);
  const start = Date.parse(startedAt);
  if (Number.isNaN(point) || Number.isNaN(start)) return null;
  return Math.max(0, Math.round((start - point) / 60_000));
}

/** Whether a run is still holding something at the provider. */
export function drillRunHoldsCopy(run: Pick<RestoreDrillRun, "cleanupState">): boolean {
  return run.cleanupState === "pending" || run.cleanupState === "failed";
}
