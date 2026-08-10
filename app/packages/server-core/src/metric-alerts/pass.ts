/**
 * The poller's metric-alert pass: claim due rules, evaluate them, reschedule.
 *
 * `metric_alert_rules.next_eval_at` is the due-time column AND the claim
 * lease, exactly like `accounts.next_poll_at`: the claim is one
 * `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`
 * statement, so any number of poller replicas share the work without
 * double-evaluating, and a replica that dies mid-pass simply lets its rules
 * come due again when the lease expires. The normal completion path
 * overwrites the lease with the true next cadence.
 *
 * Never throws — this runs inside the poller loop and must not fail a tick.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { metricAlertRules } from "../db/schema";
import { evaluateMetricAlertRule, type MetricAlertRuleRow } from "./eval";

/**
 * Must exceed the worst-case duration of one rule's evaluation (a Postgres
 * selector read plus one bounded ClickHouse read) with a wide margin.
 */
export const METRIC_ALERT_LEASE_MS = 5 * 60 * 1000;

/**
 * How often each rule re-evaluates. Metrics land on the resource poll cadence
 * (seconds), so a minute keeps firing latency well inside the shortest
 * allowed window (5 minutes) without hammering ClickHouse.
 */
export const METRIC_ALERT_EVAL_INTERVAL_MS = 60 * 1000;

/** Claim up to `limit` due rules, leasing each for {@link METRIC_ALERT_LEASE_MS}. */
export async function claimDueMetricAlertRules(limit: number): Promise<MetricAlertRuleRow[]> {
  const rows = await db.execute(sql`
    UPDATE metric_alert_rules
    SET next_eval_at = now() + ${METRIC_ALERT_LEASE_MS}::float8 * interval '1 millisecond'
    WHERE id IN (
      SELECT id FROM metric_alert_rules
      WHERE enabled = true
        AND deleted_at IS NULL
        AND (next_eval_at IS NULL OR next_eval_at <= now())
      ORDER BY last_eval_at ASC NULLS FIRST, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, organization_id, name, plugin_id, resource_type_id, tag_key, tag_value,
              metric_key, comparator, threshold, for_minutes, cooldown_minutes
  `);

  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["id"]),
    organizationId: String(r["organization_id"]),
    name: String(r["name"]),
    pluginId: r["plugin_id"] === null ? null : String(r["plugin_id"]),
    resourceTypeId: r["resource_type_id"] === null ? null : String(r["resource_type_id"]),
    tagKey: r["tag_key"] === null ? null : String(r["tag_key"]),
    tagValue: r["tag_value"] === null ? null : String(r["tag_value"]),
    metricKey: String(r["metric_key"]),
    comparator: String(r["comparator"]),
    threshold: Number(r["threshold"]),
    forMinutes: Number(r["for_minutes"]),
    cooldownMinutes: Number(r["cooldown_minutes"]),
  })) as MetricAlertRuleRow[];
}

/**
 * Replace the claim lease with the true next cadence. On failure the lease
 * stays in place, bounding the retry instead of hot-looping the rule.
 */
async function rescheduleRule(ruleId: string, now: Date): Promise<void> {
  try {
    await db
      .update(metricAlertRules)
      .set({
        lastEvalAt: now,
        nextEvalAt: new Date(now.getTime() + METRIC_ALERT_EVAL_INTERVAL_MS),
      })
      .where(eq(metricAlertRules.id, ruleId));
  } catch (err) {
    console.error(`[metric-alerts] rule ${ruleId} reschedule failed:`, err);
  }
}

/** What one pass did, for tests and logs. */
export interface MetricAlertPassOutcome {
  claimed: number;
}

/** Claim and evaluate a bounded batch of due rules. Never throws. */
export async function runMetricAlertPass(
  options: { limit?: number } = {},
): Promise<MetricAlertPassOutcome> {
  const limit = options.limit ?? 8;
  let claimed: MetricAlertRuleRow[];
  try {
    claimed = await claimDueMetricAlertRules(limit);
  } catch (err) {
    console.error("[metric-alerts] claim failed:", err);
    return { claimed: 0 };
  }
  if (claimed.length === 0) return { claimed: 0 };

  await Promise.allSettled(
    claimed.map(async (rule) => {
      const now = new Date();
      await evaluateMetricAlertRule(rule, now);
      await rescheduleRule(rule.id, now);
    }),
  );
  return { claimed: claimed.length };
}
