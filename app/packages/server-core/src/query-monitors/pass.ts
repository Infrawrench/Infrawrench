/**
 * The poller pass that runs due query monitors.
 *
 * The claim is the `account_quota_polls` protocol: one `UPDATE … WHERE
 * next_run_at <= now() … FOR UPDATE SKIP LOCKED` both selects the batch and
 * pushes its due time forward, so N poller replicas share the work without a
 * second table and a crashed replica's monitors simply come due again.
 *
 * Pushing `next_run_at` forward **before** running is deliberate. The
 * alternative — run, then reschedule — means a monitor whose query hangs until
 * the process dies is claimed again immediately by the next replica, and a slow
 * query becomes a stampede against the customer's own database.
 */
import { sql } from "drizzle-orm";
import { foldMonitorRun, describeQueryMonitor } from "@infrawrench/client-core";

import { db } from "../db/client";
import { queryMonitors } from "../db/query-monitor-schema";
import { routeAlert } from "../alerts/route";
import { runMonitorQuery } from "./store";

export interface QueryMonitorPassOptions {
  /** Monitors to claim per tick. */
  limit?: number;
}

interface ClaimedMonitor extends Record<string, unknown> {
  id: string;
  organizationId: string;
  accountId: string;
  resourceId: string | null;
  resourceTypeId: string | null;
  name: string;
  sql: string;
  mode: "scalar" | "rowCount";
  operator: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
  threshold: number;
  consecutiveBreaches: number;
  breachStreak: number;
  intervalMinutes: number;
}

/**
 * Claim a batch of due monitors, pushing each one's next run forward.
 *
 * `FOR UPDATE SKIP LOCKED` in the subquery is what makes two replicas take
 * disjoint batches rather than the same one.
 */
async function claimDueMonitors(limit: number): Promise<ClaimedMonitor[]> {
  const rows = await db.execute<ClaimedMonitor>(sql`
    UPDATE ${queryMonitors}
    SET next_run_at = now() + make_interval(mins => ${queryMonitors.intervalMinutes})
    WHERE id IN (
      SELECT id FROM ${queryMonitors}
      WHERE enabled = true AND next_run_at <= now()
      ORDER BY next_run_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING
      id,
      organization_id AS "organizationId",
      account_id AS "accountId",
      resource_id AS "resourceId",
      resource_type_id AS "resourceTypeId",
      name,
      sql,
      mode,
      operator,
      threshold,
      consecutive_breaches AS "consecutiveBreaches",
      breach_streak AS "breachStreak",
      interval_minutes AS "intervalMinutes"
  `);
  return rows as unknown as ClaimedMonitor[];
}

/**
 * Run one claimed monitor and record what it concluded.
 *
 * Returns whether an alert was raised, which is what the pass counts.
 */
async function runOne(monitor: ClaimedMonitor): Promise<boolean> {
  const result = await runMonitorQuery(monitor.organizationId, {
    accountId: monitor.accountId,
    resourceId: monitor.resourceId,
    resourceTypeId: monitor.resourceTypeId,
    sql: monitor.sql,
    mode: monitor.mode,
  });

  const outcome = foldMonitorRun({
    previousStreak: monitor.breachStreak,
    operator: monitor.operator,
    threshold: monitor.threshold,
    consecutiveBreaches: monitor.consecutiveBreaches,
    value: result.value,
    error: result.error,
  });

  await db
    .update(queryMonitors)
    .set({
      state: outcome.state,
      lastValue: outcome.value,
      lastError: outcome.error,
      breachStreak: outcome.breachStreak,
      lastRunAt: new Date(),
      ...(outcome.shouldAlert ? { lastAlertedAt: new Date() } : {}),
    })
    .where(sql`${queryMonitors.id} = ${monitor.id}`);

  if (!outcome.shouldAlert) return false;

  // Routed through the org's alert rules like every other alert, so a query
  // monitor can go to a channel, a phone or whoever is on call without this
  // module knowing any of that exists.
  await routeAlert({
    organizationId: monitor.organizationId,
    trigger: "metricAlerts",
    severity: "warning",
    title: `Query monitor: ${monitor.name}`,
    body:
      `${monitor.name} is breaching — ${describeQueryMonitor(monitor)}, ` +
      `and the last run returned ${outcome.value}.`,
    context: `Breached ${outcome.breachStreak} consecutive runs.`,
  });
  return true;
}

/**
 * Run every monitor that has come due.
 *
 * Never throws: the pass runs inside the poller loop and must not be able to
 * fail a tick. Monitors run **sequentially** rather than concurrently — each
 * one opens a connection to a customer database, and a batch fanned out in
 * parallel is a connection spike against somebody else's production.
 */
export async function runQueryMonitorPass(
  options: QueryMonitorPassOptions = {},
): Promise<{ ran: number; alerted: number }> {
  let claimed: ClaimedMonitor[];
  try {
    claimed = await claimDueMonitors(options.limit ?? 5);
  } catch (err) {
    console.error("[query-monitors] failed to claim due monitors:", err);
    return { ran: 0, alerted: 0 };
  }

  let alerted = 0;
  for (const monitor of claimed) {
    try {
      if (await runOne(monitor)) alerted += 1;
    } catch (err) {
      console.error(`[query-monitors] monitor ${monitor.id} failed:`, err);
    }
  }
  return { ran: claimed.length, alerted };
}
