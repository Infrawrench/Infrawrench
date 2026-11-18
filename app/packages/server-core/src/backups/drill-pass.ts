/**
 * The poller pass that runs automatic restore drills.
 *
 * Each tick does two things:
 *
 * 1. **Queue due schedules.** One `UPDATE … FOR UPDATE SKIP LOCKED` pushes each
 *    due schedule's next run forward before anything starts (the query-monitor
 *    protocol: a run that hangs must not be claimed again by the next replica)
 *    and a run row is inserted for each. A schedule with a run still going, or a
 *    copy still waiting to be deleted, is skipped: one copy per database at a
 *    time.
 * 2. **Advance runs one step.** Runs are claimed with a short lease and moved
 *    along `starting` → `restoring` → `cleaning` → `done`. No step waits for a
 *    provider: a copy that is not ready yet is simply looked at again later.
 *
 * The rules that make it safe to run unattended:
 *
 * - **The copy is always deleted.** Every path out of `restoring` (ready,
 *   failed, timed out, check failed, plugin threw) goes through `cleaning`, and
 *   `cleaning` retries with backoff for as long as it takes. Only the provider
 *   confirming the copy is gone ends a run.
 * - **A cleanup failure is loud.** The run shows it, and after a few failed
 *   attempts the org's alert rules hear about it as critical.
 * - **The check is read-only.** The schedule's query goes through the same
 *   allowlist query monitors use, re-checked here at execution time.
 * - **A run interrupted before the copy was recorded is not retried.** Starting
 *   again would make a second copy and lose track of the first; instead the run
 *   fails, names the copy, and alerts, so a person can delete it.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  drillCheckVerdict,
  drillRpoMinutes,
  drillRtoMinutes,
  monitorSqlProblem,
  readMonitorValue,
  type DrillRunOutcome,
} from "@infrawrench/client-core";
import type { RestoreDrillPoint, RestoreDrillStatus } from "@infrawrench/plugin-base";

import { db } from "../db/client";
import { resources } from "../db/schema";
import { restoreDrills } from "../db/restore-drill-schema";
import { restoreDrillRuns, restoreDrillSchedules } from "../db/restore-drill-schedule-schema";
import { getOrgAccountClient } from "../org-accounts";
import { getPlugin } from "../plugin-loader";
import { guardDriverConnection } from "../egress-guard";
import { sqlDrivers } from "../drivers";
import { routeAlert } from "../alerts/route";
import { insertRun } from "./drill-schedules";

type RunRow = typeof restoreDrillRuns.$inferSelect;

export interface RestoreDrillPassOptions {
  /** Schedules to queue per tick. */
  scheduleLimit?: number;
  /** Runs to advance per tick. */
  runLimit?: number;
  now?: () => Date;
}

/** How often a copy that is not ready yet is looked at again. */
const POLL_SECONDS = 20;
/** How long one replica owns a run while it takes a step. */
const LEASE_MINUTES = 5;
/** Failed deletes before the stranded copy is raised as an alert. */
const CLEANUP_ALERT_AFTER = 3;
/** Ceiling on the wait between delete attempts. */
const MAX_CLEANUP_BACKOFF_MINUTES = 60;
/** The check is abandoned after this long, as a failed check. */
const CHECK_TIMEOUT_MS = 60_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const unfinished = () => notInArray(restoreDrillRuns.state, ["done"]);

async function queueDueSchedules(limit: number): Promise<number> {
  const busy = db
    .select({ id: restoreDrillRuns.scheduleId })
    .from(restoreDrillRuns)
    .where(and(eq(restoreDrillRuns.scheduleId, restoreDrillSchedules.id), unfinished()));
  const due = db
    .select({ id: restoreDrillSchedules.id })
    .from(restoreDrillSchedules)
    .where(
      and(
        eq(restoreDrillSchedules.enabled, true),
        sql`${restoreDrillSchedules.nextRunAt} <= now()`,
        sql`NOT EXISTS (${busy})`,
      ),
    )
    .orderBy(restoreDrillSchedules.nextRunAt)
    .limit(limit)
    .for("update", { skipLocked: true });
  const claimed = await db
    .update(restoreDrillSchedules)
    .set({
      nextRunAt: sql`now() + make_interval(days => ${restoreDrillSchedules.intervalDays})`,
    })
    .where(inArray(restoreDrillSchedules.id, due))
    .returning();
  for (const schedule of claimed) await insertRun(schedule, "schedule", null);
  return claimed.length;
}

/**
 * Claim runs that are due a step, returning each with whether it had been
 * claimed before. A run still `starting` that had a lease was interrupted
 * mid-start, which the step handles differently.
 */
async function claimRuns(limit: number): Promise<Array<{ run: RunRow; reclaimed: boolean }>> {
  const picked = await db.execute<{ id: string; prev_lease: Date | null }>(sql`
    WITH picked AS (
      SELECT id, lease_until AS prev_lease FROM ${restoreDrillRuns}
      WHERE state <> 'done'
        AND next_step_at <= now()
        AND (lease_until IS NULL OR lease_until < now())
      ORDER BY next_step_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${restoreDrillRuns} r
    SET lease_until = now() + make_interval(mins => ${LEASE_MINUTES})
    FROM picked
    WHERE r.id = picked.id
    RETURNING r.id, picked.prev_lease
  `);
  if (picked.length === 0) return [];
  const rows = await db
    .select()
    .from(restoreDrillRuns)
    .where(
      inArray(
        restoreDrillRuns.id,
        picked.map((p) => p.id),
      ),
    );
  const reclaimed = new Map(picked.map((p) => [p.id, p.prev_lease !== null]));
  return rows.map((run) => ({ run, reclaimed: reclaimed.get(run.id) ?? false }));
}

async function save(runId: string, patch: Partial<RunRow>): Promise<void> {
  await db
    .update(restoreDrillRuns)
    .set({ ...patch, leaseUntil: null })
    .where(eq(restoreDrillRuns.id, runId));
}

/** Update a run without giving up the lease, for marks taken mid-step. */
async function mark(runId: string, patch: Partial<RunRow>): Promise<void> {
  await db.update(restoreDrillRuns).set(patch).where(eq(restoreDrillRuns.id, runId));
}

async function resourceName(run: RunRow): Promise<string> {
  const [row] = await db
    .select({ name: resources.displayName })
    .from(resources)
    .where(and(eq(resources.organizationId, run.organizationId), eq(resources.id, run.resourceId)))
    .limit(1);
  return row?.name ?? run.resourceId;
}

async function copyNoun(accountPluginId: string | null): Promise<string> {
  if (!accountPluginId) return "copy";
  const loaded = await getPlugin(accountPluginId);
  return loaded?.plugin.manifest.restoreDrill?.copyNoun ?? "copy";
}

/**
 * Write the outcome into the drill log the manual flow uses. Performed at the
 * run's start; the restore time is what the copy took to take connections.
 */
async function recordDrill(
  run: RunRow,
  outcome: DrillRunOutcome,
  detail: string,
  restoreSeconds: number | null,
): Promise<string> {
  const id = randomUUID();
  await db.insert(restoreDrills).values({
    id,
    organizationId: run.organizationId,
    resourceId: run.resourceId,
    performedAt: run.startedAt,
    outcome,
    rtoMinutes: restoreSeconds === null ? null : drillRtoMinutes(restoreSeconds),
    rpoMinutes: drillRpoMinutes(
      run.restorePointAt?.toISOString() ?? null,
      run.startedAt.toISOString(),
    ),
    restoredFrom: run.restoredFrom?.slice(0, 300) ?? null,
    notes: detail.slice(0, 4000),
    runId: run.id,
    performedByUserId: run.createdByUserId,
  });
  return id;
}

async function alertFailedDrill(run: RunRow, detail: string): Promise<void> {
  const name = await resourceName(run);
  await routeAlert({
    organizationId: run.organizationId,
    trigger: "restoreDrillAlerts",
    severity: "warning",
    title: `Restore drill failed: ${name}`,
    body: `The automatic restore drill of ${name} did not pass. ${detail}`,
    ...(run.restoredFrom ? { context: `Restored from ${run.restoredFrom}.` } : {}),
  }).catch((error: unknown) => console.error("[restore-drills] alert failed:", error));
}

/** Decide the outcome, record it, and move the run on to deleting its copy. */
async function conclude(
  run: RunRow,
  outcome: DrillRunOutcome,
  detail: string,
  extra: Partial<RunRow> = {},
): Promise<RunRow> {
  const restoreSeconds = extra.restoreSeconds ?? run.restoreSeconds;
  const merged = { ...run, ...extra };
  const drillId = await recordDrill(merged, outcome, detail, restoreSeconds ?? null);
  const patch: Partial<RunRow> = {
    ...extra,
    outcome,
    detail,
    restoreDrillId: drillId,
    state: "cleaning",
    nextStepAt: new Date(),
  };
  await save(run.id, patch);
  if (outcome === "failed") await alertFailedDrill(merged, detail);
  return { ...merged, ...patch };
}

async function runCheck(
  connection: { driver: string; connectionString: string; caCert?: string },
  run: RunRow,
): Promise<{ value: number | null; error: string | null }> {
  const statement = run.verifySql ?? "";
  // Re-checked at execution, as query monitors do: a stored row is not proof.
  const guard = monitorSqlProblem(statement);
  if (guard) return { value: null, error: guard };
  const driver = sqlDrivers.get(connection.driver);
  if (!driver) return { value: null, error: `This server has no ${connection.driver} driver.` };
  try {
    await guardDriverConnection(driver, connection.connectionString, {
      accountId: run.accountId,
      organizationId: run.organizationId,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`the query ran longer than ${CHECK_TIMEOUT_MS / 1000} seconds`)),
        CHECK_TIMEOUT_MS,
      );
    });
    try {
      const rows = (await Promise.race([
        driver.query(
          connection.connectionString,
          statement,
          connection.caCert ? { caCert: connection.caCert } : undefined,
        ),
        timeout,
      ])) as Record<string, unknown>[];
      return { value: readMonitorValue(rows, run.verifyMode), error: null };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { value: null, error: message(error) };
  }
}

async function stepStarting(run: RunRow, reclaimed: boolean): Promise<void> {
  const ctx = await getOrgAccountClient(run.accountId, run.organizationId);
  const noun = await copyNoun(ctx?.plugin.manifest.id ?? null);
  if (reclaimed && run.cleanupState === "pending" && !run.copyRef) {
    // The previous attempt asked the provider for a copy and never recorded
    // the handle. Starting again would make a second one and lose the first.
    const detail = `The run was interrupted while the ${noun} was being created. Check the provider for a ${noun} named ${run.copyName} and delete it.`;
    await save(run.id, {
      state: "done",
      outcome: "failed",
      detail,
      cleanupState: "failed",
      cleanupError: detail,
      finishedAt: new Date(),
    });
    await recordDrill(run, "failed", detail, null);
    await raiseStrandedCopy(run, detail);
    return;
  }
  if (!ctx) {
    await finishWithoutCopy(run, "The account is no longer connected.");
    return;
  }
  if (!ctx.client.startRestoreDrill) {
    await finishWithoutCopy(run, "This provider no longer supports automatic drills.");
    return;
  }
  const restorePoint: RestoreDrillPoint =
    run.restorePoint === "point-in-time"
      ? { kind: "point-in-time", at: (run.pointInTimeAt ?? run.startedAt).toISOString() }
      : { kind: "latest-backup" };
  // From here a copy may exist, so an interrupted run must not start another.
  await mark(run.id, { cleanupState: "pending" });
  try {
    const handle = await ctx.client.startRestoreDrill({
      resourceTypeId: run.resourceTypeId,
      resourceId: run.resourceId,
      accountId: run.accountId,
      restorePoint,
      copyName: run.copyName,
    });
    await save(run.id, {
      state: "restoring",
      copyRef: handle.ref,
      restoredFrom: handle.restoredFrom,
      restorePointAt: handle.restorePointAt ? new Date(handle.restorePointAt) : null,
      cleanupState: "pending",
      nextStepAt: new Date(Date.now() + POLL_SECONDS * 1000),
    });
  } catch (error) {
    await finishWithoutCopy(run, `The provider refused the restore: ${message(error)}`);
  }
}

/** A run that never made a copy: record the failure, nothing to delete. */
async function finishWithoutCopy(run: RunRow, detail: string): Promise<void> {
  const drillId = await recordDrill(run, "failed", detail, null);
  await save(run.id, {
    state: "done",
    outcome: "failed",
    detail,
    cleanupState: "none",
    restoreDrillId: drillId,
    finishedAt: new Date(),
  });
  await alertFailedDrill(run, detail);
}

async function stepRestoring(run: RunRow, now: Date): Promise<RunRow | null> {
  const ctx = await getOrgAccountClient(run.accountId, run.organizationId);
  const noun = await copyNoun(ctx?.plugin.manifest.id ?? null);
  const minutes = Math.round((run.deadlineAt.getTime() - run.startedAt.getTime()) / 60_000);
  if (now >= run.deadlineAt) {
    return conclude(run, "failed", `The ${noun} was not ready within the ${minutes} minute limit.`);
  }
  if (!ctx?.client.checkRestoreDrill || !run.copyRef) {
    return conclude(run, "failed", "The account is no longer connected.");
  }
  let status: RestoreDrillStatus;
  try {
    status = await ctx.client.checkRestoreDrill(run.copyRef, run.accountId);
  } catch (error) {
    // A provider hiccup while the copy comes up is not a failed restore; keep
    // looking until the time limit says otherwise.
    await save(run.id, {
      detail: `Last check: ${message(error)}`,
      nextStepAt: new Date(now.getTime() + POLL_SECONDS * 1000),
    });
    return null;
  }
  if (status.state === "pending") {
    await save(run.id, {
      detail: status.detail ?? null,
      nextStepAt: new Date(now.getTime() + POLL_SECONDS * 1000),
    });
    return null;
  }
  if (status.state === "failed") {
    return conclude(run, "failed", `The provider could not create the ${noun}: ${status.message}`);
  }

  const restoreSeconds = Math.max(0, Math.round((now.getTime() - run.startedAt.getTime()) / 1000));
  const ready: Partial<RunRow> = {
    readyAt: now,
    restoreSeconds,
    ...(status.restorePointAt ? { restorePointAt: new Date(status.restorePointAt) } : {}),
  };
  const withReady = { ...run, ...ready };
  if (!run.verifySql) {
    return conclude(
      withReady,
      "restored-unverified",
      `The ${noun} came up; no check is set, so nothing inside it was verified.`,
      ready,
    );
  }
  const result = await runCheck(status.connection, withReady);
  const verdict = drillCheckVerdict(
    {
      verifyMode: run.verifyMode,
      verifyOperator: run.verifyOperator,
      verifyThreshold: run.verifyThreshold,
    },
    result,
  );
  return conclude(withReady, verdict.passed ? "verified" : "failed", verdict.detail, {
    ...ready,
    verifyValue: result.value,
  });
}

async function raiseStrandedCopy(run: RunRow, detail: string): Promise<void> {
  const name = await resourceName(run);
  await routeAlert({
    organizationId: run.organizationId,
    trigger: "restoreDrillAlerts",
    severity: "critical",
    title: `Restore drill copy not deleted: ${name}`,
    body: `The copy ${run.copyName} made to drill ${name} could not be deleted and may still be running at the provider. ${detail}`,
  }).catch((error: unknown) => console.error("[restore-drills] alert failed:", error));
  await save(run.id, { cleanupAlerted: true });
}

async function stepCleaning(run: RunRow, now: Date): Promise<void> {
  if (!run.copyRef) {
    await save(run.id, { state: "done", cleanupState: "none", finishedAt: now });
    return;
  }
  let failure: string | null = null;
  try {
    const ctx = await getOrgAccountClient(run.accountId, run.organizationId);
    if (!ctx) failure = "The account is no longer connected, so the copy cannot be deleted.";
    else if (!ctx.client.endRestoreDrill) failure = "This provider can no longer delete the copy.";
    else await ctx.client.endRestoreDrill(run.copyRef, run.accountId);
  } catch (error) {
    failure = message(error);
  }
  if (failure === null) {
    await save(run.id, {
      state: "done",
      cleanupState: "done",
      cleanupError: null,
      finishedAt: now,
    });
    return;
  }
  const attempts = run.cleanupAttempts + 1;
  const backoffMinutes = Math.min(MAX_CLEANUP_BACKOFF_MINUTES, 2 ** (attempts - 1));
  console.error(`[restore-drills] run ${run.id}: deleting ${run.copyName} failed:`, failure);
  await save(run.id, {
    cleanupState: "failed",
    cleanupError: failure,
    cleanupAttempts: attempts,
    nextStepAt: new Date(now.getTime() + backoffMinutes * 60_000),
  });
  if (attempts >= CLEANUP_ALERT_AFTER && !run.cleanupAlerted) {
    await raiseStrandedCopy(run, `Last error: ${failure}`);
  }
}

/** One step of one claimed run. Exported for the tests. */
export async function advanceDrillRun(run: RunRow, reclaimed: boolean, now: Date): Promise<void> {
  switch (run.state) {
    case "starting":
      return stepStarting(run, reclaimed);
    case "restoring": {
      const next = await stepRestoring(run, now);
      // Delete the copy in the same tick rather than waiting for the next one.
      if (next?.state === "cleaning") await stepCleaning(next, now);
      return;
    }
    case "cleaning":
      return stepCleaning(run, now);
    case "done":
      return;
  }
}

/**
 * Queue due schedules and advance every run that is due a step.
 *
 * Never throws: it runs inside the poller loop. Runs are stepped one at a time,
 * since each may open a connection to a copy of a customer's database.
 */
export async function runRestoreDrillPass(
  options: RestoreDrillPassOptions = {},
): Promise<{ queued: number; stepped: number }> {
  const now = options.now ?? (() => new Date());
  let queued = 0;
  try {
    queued = await queueDueSchedules(options.scheduleLimit ?? 5);
  } catch (error) {
    console.error("[restore-drills] failed to queue due schedules:", error);
  }
  let claimed: Array<{ run: RunRow; reclaimed: boolean }> = [];
  try {
    claimed = await claimRuns(options.runLimit ?? 10);
  } catch (error) {
    console.error("[restore-drills] failed to claim runs:", error);
    return { queued, stepped: 0 };
  }
  for (const { run, reclaimed } of claimed) {
    try {
      await advanceDrillRun(run, reclaimed, now());
    } catch (error) {
      // The lease runs out and the next tick picks the run up again.
      console.error(`[restore-drills] run ${run.id} failed a step:`, error);
    }
  }
  return { queued, stepped: claimed.length };
}
