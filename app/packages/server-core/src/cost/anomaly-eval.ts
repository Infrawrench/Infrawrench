/**
 * Cost anomaly evaluation. Runs from the poller after each successful cost
 * collection for an org — the same trigger point as budget evaluation, because
 * org cost data only changes when collection runs, so a daily-per-account
 * collection cadence gives a daily detection cadence for free.
 *
 * The maths live in `anomaly-detect.ts` (pure, unit-tested); this module reads
 * the series from ClickHouse, persists what was flagged, and fans out through
 * the existing notification transports under the `anomalyAlerts` trigger.
 *
 * Dedup happens in two layers:
 * - The unique index on cost_anomalies (org, day, dimension, key, currency)
 *   makes each anomaly fire at most once, however many collection passes
 *   re-examine that day — `onConflictDoNothing` + RETURNING tells us whether
 *   this detection is fresh, and only fresh detections can notify.
 * - A cross-day cooldown: a sustained level shift is anomalous against the
 *   trailing window for several days running, and re-alerting each morning
 *   about the same jump is noise. A fresh anomaly for a key that already has
 *   one recorded in the previous `COOLDOWN_DAYS` days is stored (the list UI
 *   still shows it) but not notified.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/client";
import { costAnomalies } from "../db/schema";
import { queryCosts } from "../clickhouse/cost-readers";
import { sendPushToOrg } from "../push/dispatch";
import { sendSlackToOrg } from "../slack";
import { sendMsTeamsToOrg } from "../msteams";
import {
  DEFAULT_ANOMALY_OPTIONS,
  detectSpike,
  fillDailySeries,
  type AnomalyDetectionOptions,
} from "./anomaly-detect";
import { isoDay, addDays } from "./dates";

/** Days of history the baseline is computed over (excluding the day itself). */
const BASELINE_DAYS = 28;

/** Days a key stays quiet after notifying, so a level shift alerts once. */
const COOLDOWN_DAYS = 7;

/** The two breakdowns evaluated — matches the `dimension` column's type. */
const DIMENSIONS = ["provider", "service"] as const;
type AnomalyDimension = (typeof DIMENSIONS)[number];

/** Deep link to the costs panel, for the Slack/Teams message button. */
function costsUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/costs`;
}

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: amount < 10 ? 2 : 0,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

interface FreshAnomaly {
  id: string;
  dimension: AnomalyDimension;
  dimensionKey: string;
  currency: string;
  actual: number;
  mean: number;
  threshold: number;
}

/**
 * Detect anomalies in one dimension's series for `day`, insert fresh ones, and
 * return those that were freshly inserted (i.e. not seen by a previous pass).
 */
async function detectForDimension(
  organizationId: string,
  dimension: AnomalyDimension,
  day: string,
  options: AnomalyDetectionOptions,
): Promise<FreshAnomaly[]> {
  const from = addDays(day, -BASELINE_DAYS);
  const groups = await queryCosts(organizationId, {
    from,
    to: day,
    binning: "daily",
    groupBy: dimension,
    filters: [],
  });

  const fresh: FreshAnomaly[] = [];
  for (const group of groups) {
    if (!group.key) continue; // rows with no value for this dimension
    const byDay = new Map<string, number>();
    for (const p of group.points) byDay.set(p.bucket, (byDay.get(p.bucket) ?? 0) + p.amount);

    const baseline = fillDailySeries(byDay, from, addDays(day, -1));
    const actual = byDay.get(day) ?? 0;
    const spike = detectSpike(baseline, actual, options);
    if (!spike) continue;

    const [inserted] = await db
      .insert(costAnomalies)
      .values({
        id: randomUUID(),
        organizationId,
        day,
        dimension,
        dimensionKey: group.key,
        currency: group.currency,
        actualAmountCents: Math.round(spike.actual * 100),
        baselineAmountCents: Math.round(spike.mean * 100),
        thresholdAmountCents: Math.round(spike.threshold * 100),
      })
      .onConflictDoNothing()
      .returning({ id: costAnomalies.id });
    if (!inserted) continue; // this day's anomaly was already recorded

    fresh.push({
      id: inserted.id,
      dimension,
      dimensionKey: group.key,
      currency: group.currency,
      actual: spike.actual,
      mean: spike.mean,
      threshold: spike.threshold,
    });
  }
  return fresh;
}

/** True when the same key already has an anomaly within the cooldown window. */
async function inCooldown(
  organizationId: string,
  anomaly: FreshAnomaly,
  day: string,
): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(costAnomalies)
    .where(
      and(
        eq(costAnomalies.organizationId, organizationId),
        eq(costAnomalies.dimension, anomaly.dimension),
        eq(costAnomalies.dimensionKey, anomaly.dimensionKey),
        eq(costAnomalies.currency, anomaly.currency),
        gte(costAnomalies.day, addDays(day, -COOLDOWN_DAYS)),
        lt(costAnomalies.day, day),
      ),
    );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Evaluate yesterday's spend for an org against its trailing baseline, per
 * provider and per service, and notify freshly detected anomalies through
 * push/Slack/Teams. Errors are logged, never thrown — anomaly evaluation must
 * not break the poller's cost pass. Amounts compare in currency units; the
 * stored rows are cents, matching the budget tables.
 */
export async function detectCostAnomaliesForOrg(
  organizationId: string,
  now = new Date(),
  options: AnomalyDetectionOptions = DEFAULT_ANOMALY_OPTIONS,
): Promise<void> {
  // Yesterday is the latest day provider billing data can be complete for;
  // today is always partial and would read as a dip, never a spike.
  const day = addDays(isoDay(now), -1);

  for (const dimension of DIMENSIONS) {
    let fresh: FreshAnomaly[];
    try {
      fresh = await detectForDimension(organizationId, dimension, day, options);
    } catch (err) {
      console.error(`[anomaly-eval] ${dimension} detection failed for org ${organizationId}:`, err);
      continue;
    }

    for (const anomaly of fresh) {
      try {
        if (await inCooldown(organizationId, anomaly, day)) continue;

        const label = dimension === "provider" ? "provider" : "service";
        const title = `Cost anomaly: ${anomaly.dimensionKey}`;
        const body =
          `infrawrench spend anomaly: ${label} "${anomaly.dimensionKey}" cost ` +
          `${formatAmount(anomaly.actual, anomaly.currency)} on ${day}, against a ` +
          `${formatAmount(anomaly.mean, anomaly.currency)}/day baseline over the prior ${BASELINE_DAYS} days`;

        const pushed = await sendPushToOrg(organizationId, "anomalyAlerts", {
          title,
          body,
          data: {
            type: "cost_anomaly",
            orgId: organizationId,
            day,
            dimension,
            dimensionKey: anomaly.dimensionKey,
          },
        });
        const url = costsUrl(organizationId);
        const slacked = await sendSlackToOrg(organizationId, "anomalyAlerts", {
          title,
          body,
          context: `${day} · ${label}`,
          ...(url ? { url } : {}),
        });
        const teamed = await sendMsTeamsToOrg(organizationId, "anomalyAlerts", {
          title,
          body,
          context: `${day} · ${label}`,
          ...(url ? { url } : {}),
        });
        if (pushed.succeeded > 0 || slacked.succeeded > 0 || teamed.succeeded > 0) {
          await db
            .update(costAnomalies)
            .set({ notifiedAt: new Date() })
            .where(eq(costAnomalies.id, anomaly.id));
        }
      } catch (err) {
        console.error(`[anomaly-eval] notify failed for anomaly ${anomaly.id}:`, err);
      }
    }
  }
}
