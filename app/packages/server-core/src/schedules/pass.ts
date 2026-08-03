/**
 * The poller's sleep/wake schedule pass — finds due transitions and invokes
 * the plugin's declared lifecycle start/stop action server-side.
 *
 * Correctness properties, in the order they bite:
 *
 * - **One claim per transition.** `next_transition_at` doubles as the claim
 *   lease (`claimDueSchedules`, the `claimDueAccounts` statement over
 *   `resource_schedules`): N poller replicas claim disjoint rows, and a
 *   replica that dies mid-work simply lets the row come due again at lease
 *   expiry.
 * - **Idempotency across restarts.** The due transition is recomputed from
 *   the timing (`computeMostRecentTransition`) and keyed
 *   (`"<ISO>:<action>"`); a row whose `last_transition_key` already carries
 *   that key is rescheduled without re-invoking, so a restart after the
 *   completion write can't fire the same window twice. Downtime longer than
 *   a window executes only the *latest* missed transition — the one that
 *   decides the current desired state — never a replay of history.
 * - **Edits beat stale runs.** The lease instant doubles as a claim token
 *   (`claimGuard`): every completion write requires `next_transition_at` to
 *   still hold the claimed value. A schedule edit or pause recomputes that
 *   column, so a superseded run's completion matches nothing — the edit's
 *   timing (and a paused row's null `next_transition_at`) always wins.
 * - **Freezes are respected.** An in-effect org change freeze skips the
 *   transition: logged, recorded as `skipped_freeze` on the row (surfaced in
 *   every schedule list), and the key is spent so the skipped transition is
 *   not retried the moment the freeze lifts mid-window.
 * - **Don't fight the sync.** After a successful transition the stored
 *   resource row's status field is set to the declared desired value and a
 *   change-timeline event is recorded with `origin: "schedule"` — the next
 *   poll sees the expected state, so the transition never reads as drift,
 *   and the feed attributes it to the schedule rather than to nobody.
 * - **Failures are never silent.** Every failure logs `[schedules]`-prefixed
 *   and lands in `last_run_status`/`last_run_error`; a fresh failure retries
 *   on a short lease until the transition is `GIVE_UP_MS` old, then the pass
 *   records the failure and moves to the next window.
 */
import { sql, and, eq } from "drizzle-orm";
import {
  computeMostRecentTransition,
  transitionKey,
  type ScheduleAction,
  type ScheduleTransition,
} from "@infrawrench/client-core";
import type { LifecycleActionsDeclaration } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { resourceSchedules, resources } from "../db/schema";
import { findActiveChangeFreeze } from "../change-freezes";
import { getOrgAccountClient } from "../org-accounts";
import { recordResourceChanges } from "../resource-changes";
import { lifecycleForType, nextTransitionColumns, type ScheduleRecord } from "./store";

/** Lease written into `next_transition_at` by the claim. */
export const SCHEDULE_LEASE_MS = 10 * 60 * 1000;
/** Retry cadence for a transition whose invoke failed. */
export const SCHEDULE_RETRY_MS = 10 * 60 * 1000;
/** How long a failing transition is retried before the pass gives up on it. */
export const SCHEDULE_GIVE_UP_MS = 60 * 60 * 1000;

export interface SchedulePassOptions {
  /** Max schedules to execute per tick. */
  limit?: number;
  /** Fixed clock for tests. */
  now?: number;
}

export interface SchedulePassResult {
  claimed: number;
  executed: number;
  skippedFreeze: number;
  failed: number;
}

/** A claimed row: its id plus the claim token the completion must present. */
interface ClaimedSchedule {
  id: string;
  /**
   * The exact lease instant the claim wrote into `next_transition_at`,
   * carried as Postgres' own text rendering so no driver rounds the
   * microseconds away. Every completion/reschedule write is guarded on the
   * column still holding this value — a schedule edit (or pause) recomputes
   * `next_transition_at`, which invalidates the token, so a stale claimed run
   * can never clobber the edit (and a paused row can never be handed a
   * non-null `next_transition_at` back).
   */
  claimToken: string;
}

/** Claim due, unpaused schedules — the `claimDueAccounts` protocol. */
async function claimDueSchedules(limit: number): Promise<ClaimedSchedule[]> {
  const rows = await db.execute(sql`
    UPDATE resource_schedules
    SET next_transition_at = now() + ${SCHEDULE_LEASE_MS}::float8 * interval '1 millisecond',
        updated_at = now()
    WHERE id IN (
      SELECT id FROM resource_schedules
      WHERE paused = false
        AND next_transition_at IS NOT NULL
        AND next_transition_at <= now()
      ORDER BY next_transition_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, next_transition_at::text AS claim_token
  `);
  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["id"]),
    claimToken: String(r["claim_token"]),
  }));
}

/**
 * WHERE fragment shared by the completion writes: the row is only touched
 * while it still carries our claim lease. An edit made mid-run recomputed
 * `next_transition_at`, so the guarded update matches nothing and the edit's
 * timing wins over the superseded run's.
 */
function claimGuard(rowId: string, claimToken: string) {
  return and(
    eq(resourceSchedules.id, rowId),
    sql`${resourceSchedules.nextTransitionAt} = ${claimToken}::timestamp`,
  );
}

interface CompletionUpdate {
  status: "ok" | "failed" | "skipped_freeze";
  error?: string | undefined;
  /** Spend the idempotency key (default true; false = leave it retryable). */
  spendKey?: boolean;
  /** Override the reschedule instant (retry path). */
  retryAt?: Date | undefined;
}

async function completeRun(
  row: ScheduleRecord,
  due: ScheduleTransition,
  now: number,
  claimToken: string,
  update: CompletionUpdate,
): Promise<void> {
  const timing = {
    daysOfWeek: row.daysOfWeek,
    stopTime: row.stopTime,
    startTime: row.startTime,
    timezone: row.timezone,
  };
  const reschedule = update.retryAt
    ? { nextTransitionAt: update.retryAt, nextTransitionAction: due.action }
    : nextTransitionColumns(timing, false, now);
  const updated = await db
    .update(resourceSchedules)
    .set({
      ...reschedule,
      ...(update.spendKey === false ? {} : { lastTransitionKey: transitionKey(due) }),
      lastRunAt: new Date(now),
      lastRunAction: due.action,
      lastRunStatus: update.status,
      lastRunError: update.error ?? null,
      updatedAt: new Date(now),
    })
    .where(claimGuard(row.id, claimToken))
    .returning({ id: resourceSchedules.id });
  if (updated.length === 0) {
    console.warn(
      `[schedules] completion for schedule ${row.id} superseded by a concurrent edit; ` +
        `leaving the edited row's timing in place`,
    );
  }
}

/** Reschedule without recording a run (nothing was due / already ran). */
async function rescheduleOnly(row: ScheduleRecord, now: number, claimToken: string): Promise<void> {
  const timing = {
    daysOfWeek: row.daysOfWeek,
    stopTime: row.stopTime,
    startTime: row.startTime,
    timezone: row.timezone,
  };
  await db
    .update(resourceSchedules)
    .set({ ...nextTransitionColumns(timing, false, now), updatedAt: new Date(now) })
    .where(claimGuard(row.id, claimToken));
}

function desiredStateValue(
  lifecycle: LifecycleActionsDeclaration,
  action: ScheduleAction,
): string | null {
  const values = action === "stop" ? lifecycle.stoppedValues : lifecycle.runningValues;
  return values?.[0] ?? null;
}

function stateMatches(value: unknown, values: string[] | undefined): boolean {
  if (typeof value !== "string" || !values) return false;
  const lowered = value.toLowerCase();
  return values.some((v) => v.toLowerCase() === lowered);
}

/**
 * Record the transition in the change timeline attributed to the schedule,
 * and write the expected state into the stored resource row so the next sync
 * doesn't diff the transition as drift. Best-effort: a bookkeeping failure
 * must never turn a succeeded provider call into a failed run.
 */
async function attributeTransition(
  row: ScheduleRecord,
  lifecycle: LifecycleActionsDeclaration,
  action: ScheduleAction,
  resource: { displayName: string; fieldsJson: Record<string, unknown> },
): Promise<void> {
  try {
    const fieldKey = lifecycle.statusFieldKey;
    const desired = desiredStateValue(lifecycle, action);
    const from = fieldKey ? (resource.fieldsJson[fieldKey] ?? null) : null;
    if (fieldKey && desired !== null) {
      // Patch only the status key in place (jsonb_set) rather than writing
      // back the whole document we read earlier — a concurrent sync's update
      // to any other field must not be clobbered by this bookkeeping write.
      await db
        .update(resources)
        .set({
          fieldsJson: sql`jsonb_set(coalesce(${resources.fieldsJson}, '{}'::jsonb), ARRAY[${fieldKey}]::text[], to_jsonb(${desired}::text))`,
        })
        .where(
          and(eq(resources.id, row.resourceId), eq(resources.organizationId, row.organizationId)),
        );
    }
    await recordResourceChanges(row.organizationId, row.accountId, [
      {
        resourceId: row.resourceId,
        pluginId: row.pluginId,
        resourceTypeId: row.resourceTypeId,
        displayName: resource.displayName,
        changeKind: "updated",
        diff: [
          {
            field: fieldKey ?? "state",
            from,
            to: desired ?? (action === "stop" ? "stopped" : "running"),
          },
        ],
        origin: "schedule",
      },
    ]);
  } catch (e) {
    console.error(`[schedules] failed to attribute transition for schedule ${row.id}:`, e);
  }
}

async function executeSchedule(
  row: ScheduleRecord,
  now: number,
  claimToken: string,
): Promise<"ok" | "skipped_freeze" | "failed" | "noop"> {
  const timing = {
    daysOfWeek: row.daysOfWeek,
    stopTime: row.stopTime,
    startTime: row.startTime,
    timezone: row.timezone,
  };
  const due = computeMostRecentTransition(timing, now);
  if (!due) {
    // Nothing has ever been due (fresh schedule whose first window is ahead,
    // or timing rows edited to something invalid) — just reschedule.
    await rescheduleOnly(row, now, claimToken);
    return "noop";
  }
  if (row.lastTransitionKey === transitionKey(due)) {
    // Already executed (or deliberately skipped) — a lease-expiry re-claim or
    // a restart landed here. Reschedule without re-invoking.
    await rescheduleOnly(row, now, claimToken);
    return "noop";
  }

  // Respect an in-effect change freeze: skip, log, surface — never defer to
  // fire the moment the freeze lifts (the window's moment has passed).
  const freeze = await findActiveChangeFreeze(row.organizationId, new Date(now));
  if (freeze) {
    console.warn(
      `[schedules] skipping ${due.action} for schedule ${row.id} (resource ${row.resourceId}): ` +
        `change freeze "${freeze.name}" is in effect`,
    );
    await completeRun(row, due, now, claimToken, {
      status: "skipped_freeze",
      error: `Skipped: change freeze "${freeze.name}" was in effect`,
    });
    return "skipped_freeze";
  }

  const [resource] = await db
    .select({
      id: resources.id,
      displayName: resources.displayName,
      fieldsJson: resources.fieldsJson,
      deletedAt: resources.deletedAt,
    })
    .from(resources)
    .where(and(eq(resources.id, row.resourceId), eq(resources.organizationId, row.organizationId)))
    .limit(1);
  if (!resource || resource.deletedAt !== null) {
    console.error(
      `[schedules] schedule ${row.id}: resource ${row.resourceId} is gone from sync; skipping ${due.action}`,
    );
    await completeRun(row, due, now, claimToken, {
      status: "failed",
      error: "Resource is no longer synced (deleted upstream?) — delete this schedule",
    });
    return "failed";
  }

  const lifecycle = await lifecycleForType(row.pluginId, row.resourceTypeId);
  if (!lifecycle) {
    console.error(
      `[schedules] schedule ${row.id}: type ${row.pluginId}/${row.resourceTypeId} no longer declares lifecycle actions`,
    );
    await completeRun(row, due, now, claimToken, {
      status: "failed",
      error: "Resource type no longer declares start/stop lifecycle actions",
    });
    return "failed";
  }

  // Already in the desired state (per the last sync)? Don't re-invoke — a
  // second stop on a stopped instance is at best a no-op and at worst a
  // provider error that would read as a failed run.
  const desiredValues = due.action === "stop" ? lifecycle.stoppedValues : lifecycle.runningValues;
  if (
    lifecycle.statusFieldKey &&
    stateMatches(resource.fieldsJson[lifecycle.statusFieldKey], desiredValues)
  ) {
    await completeRun(row, due, now, claimToken, { status: "ok" });
    return "ok";
  }

  const actionId = due.action === "stop" ? lifecycle.stopActionId : lifecycle.startActionId;
  try {
    const ctx = await getOrgAccountClient(row.accountId, row.organizationId);
    if (!ctx) throw new Error("Account not found or its plugin failed to load");
    if (!ctx.client.invokeAction) {
      throw new Error(`Plugin ${row.pluginId} does not implement invokeAction`);
    }

    // Retry of a transition whose earlier attempt failed *after* the request
    // may have reached the provider (timeout, dropped response — the outcome
    // is ambiguous). The plugin contract carries no idempotency key, so the
    // guard is a live provider read: if the desired state already holds, the
    // earlier invocation landed and re-invoking would at best no-op and at
    // worst error (a second stop on a stopping instance).
    if (
      row.lastRunStatus === "failed" &&
      row.lastRunAction === due.action &&
      lifecycle.statusFieldKey &&
      desiredValues &&
      desiredValues.length > 0
    ) {
      let alreadyApplied = false;
      try {
        const live = await ctx.client.getResource(
          row.resourceTypeId,
          row.resourceId,
          row.accountId,
        );
        alreadyApplied = stateMatches(live.fields[lifecycle.statusFieldKey], desiredValues);
      } catch {
        // The pre-check is best-effort — fall through to the normal invoke.
      }
      if (alreadyApplied) {
        console.log(
          `[schedules] ${due.action} already applied at the provider for resource ` +
            `${row.resourceId} (schedule ${row.id}); skipping re-invoke`,
        );
        await attributeTransition(row, lifecycle, due.action, {
          displayName: resource.displayName,
          fieldsJson: (resource.fieldsJson ?? {}) as Record<string, unknown>,
        });
        await completeRun(row, due, now, claimToken, { status: "ok" });
        return "ok";
      }
    }

    await ctx.client.invokeAction(row.resourceTypeId, row.resourceId, actionId, row.accountId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[schedules] ${due.action} failed for schedule ${row.id} (resource ${row.resourceId}): ${message}`,
    );
    const transitionAge = now - Date.parse(due.at);
    if (transitionAge < SCHEDULE_GIVE_UP_MS) {
      // Keep the key unspent and retry on a short lease.
      await completeRun(row, due, now, claimToken, {
        status: "failed",
        error: message,
        spendKey: false,
        retryAt: new Date(now + SCHEDULE_RETRY_MS),
      });
    } else {
      await completeRun(row, due, now, claimToken, { status: "failed", error: message });
    }
    return "failed";
  }

  console.log(
    `[schedules] ${due.action} executed for resource ${row.resourceId} (schedule ${row.id})`,
  );
  await attributeTransition(row, lifecycle, due.action, {
    displayName: resource.displayName,
    fieldsJson: (resource.fieldsJson ?? {}) as Record<string, unknown>,
  });
  await completeRun(row, due, now, claimToken, { status: "ok" });
  return "ok";
}

/**
 * One schedule-pass tick: claim due schedules and execute their transitions.
 * Every schedule is individually guarded — one failure never blocks the rest
 * of the batch, and nothing here throws into the poller's tick.
 */
export async function runSchedulePass(
  options: SchedulePassOptions = {},
): Promise<SchedulePassResult> {
  const limit = options.limit ?? 4;
  const result: SchedulePassResult = { claimed: 0, executed: 0, skippedFreeze: 0, failed: 0 };

  const claimed = await claimDueSchedules(limit);
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  for (const { id, claimToken } of claimed) {
    const now = options.now ?? Date.now();
    try {
      const rows = await db
        .select()
        .from(resourceSchedules)
        .where(eq(resourceSchedules.id, id))
        .limit(1);
      const row = rows[0] as ScheduleRecord | undefined;
      if (!row || row.paused) continue;
      const outcome = await executeSchedule(row, now, claimToken);
      if (outcome === "ok") result.executed += 1;
      else if (outcome === "skipped_freeze") result.skippedFreeze += 1;
      else if (outcome === "failed") result.failed += 1;
    } catch (e) {
      result.failed += 1;
      console.error(`[schedules] pass failed for schedule ${id}:`, e);
    }
  }
  return result;
}
