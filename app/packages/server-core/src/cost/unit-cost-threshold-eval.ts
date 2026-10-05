/**
 * Unit-cost threshold evaluation: standing limits an org sets on a metric
 * ("cost per 1K requests above $0.40", "margin per customer below 30%"),
 * checked once a day after cost collection, routed through the alert layer
 * under the same `unitCostRegressionAlerts` trigger as a regression.
 *
 * ## The same number the chart draws
 *
 * Each threshold is evaluated by `runUnitCostCalculation` (the engine behind
 * the chart, the CLI and the MCP tool) over the trailing `windowDays` complete
 * days, daily-binned, and judged on the **summed** period ratio of each series:
 * Σ spend ÷ Σ metric, never the worst day and never a mean of daily ratios.
 * A threshold grouped by a label is evaluated per label value through the
 * label's cost mapping, so "margin per customer" is each customer's revenue
 * against each customer's spend.
 *
 * ## Gaps stay gaps
 *
 * A series whose window has fewer than half its days reported is skipped, not
 * judged: a window of mostly gaps has no unit cost to be above or below
 * anything. A null period value is skipped for the same reason. The "Other"
 * fold is never judged: it is a different set of label values every day.
 *
 * ## Dedup
 *
 * The regression protocol: one row per (metric, threshold, label value,
 * currency, window end) with `onConflictDoNothing`, only a fresh insert may
 * notify, and a cross-day cooldown over *notified* rows keeps a persisting
 * breach from paging every morning as the window slides.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";

import {
  DEFAULT_UNIT_COST_THRESHOLD_WINDOW_DAYS,
  describeUnitCostThreshold,
  formatUnitCostValue,
  toUnitCostScale,
  unitCostUnitLabel,
  type UnitCostQueryResponse,
  type UnitCostThreshold,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { businessMetrics, unitCostThresholdEvents } from "../db/schema";
import { alertReached, routeAlert } from "../alerts/route";
import { orgAppUrl } from "../app-url";
import { getOrgCurrencySettings } from "./currency-settings";
import { addDays, isoDay } from "./dates";
import { UnitCostRunError, metricDefFromRow, runUnitCostCalculation } from "./unit-cost-run";

/** Least time between full evaluations of one org; correctness rests on the unique index. */
const MIN_EVAL_INTERVAL_MS = 60 * 60 * 1000;
const lastEvaluatedAt = new Map<string, number>();

/**
 * Days a (threshold, label, currency) stays quiet after notifying. A week: a
 * limit breach is a standing condition, and a weekly restatement is the
 * cadence at which "still over" is news rather than noise.
 */
const COOLDOWN_DAYS = 7;

/** Most metrics with thresholds evaluated per org per pass. */
const MAX_METRICS_PER_PASS = 50;

/**
 * A threshold's identity: a hash of its own fields. Thresholds live in a jsonb
 * column with no id, and editing one should make it a new limit that can fire
 * at once rather than inherit the old one's cooldown.
 */
export function unitCostThresholdKey(threshold: UnitCostThreshold): string {
  const canonical = JSON.stringify([
    threshold.mode,
    threshold.direction,
    threshold.value,
    toUnitCostScale(threshold.scale),
    threshold.groupByLabel ?? "",
    threshold.windowDays ?? DEFAULT_UNIT_COST_THRESHOLD_WINDOW_DAYS,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** One series that breached, as the pure judge reports it. */
export interface UnitCostThresholdBreach {
  currency: string;
  labelValue: string;
  /** In the threshold's terms: currency units per `scale`, or a percent for margin. */
  observed: number;
  windowSpend: number;
}

/**
 * Judge a calculation result against a threshold: **pure**. Returns the
 * series that breached. Exported for the tests, which pin the gap and
 * minimum-coverage rules one by one.
 */
export function judgeUnitCostThreshold(
  threshold: UnitCostThreshold,
  response: UnitCostQueryResponse,
  windowDays: number,
): UnitCostThresholdBreach[] {
  const minReported = Math.ceil(windowDays / 2);
  const breaches: UnitCostThresholdBreach[] = [];
  for (const series of response.series) {
    if (series.label?.other) continue;
    if (series.overallValue === null) continue;
    const reported = series.points.reduce((n, p) => n + (p.value !== null ? p.reportedDays : 0), 0);
    if (reported < minReported) continue;
    const observed =
      threshold.mode === "margin"
        ? Math.round(series.overallValue * 10_000) / 100
        : series.overallValue;
    const breached =
      threshold.direction === "above" ? observed > threshold.value : observed < threshold.value;
    if (!breached) continue;
    breaches.push({
      currency: series.currency,
      labelValue: series.label?.value ?? "",
      observed,
      windowSpend: series.overallCost,
    });
  }
  return breaches;
}

async function inCooldown(
  metricId: string,
  thresholdKey: string,
  labelValue: string,
  currency: string,
  windowTo: string,
): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(unitCostThresholdEvents)
    .where(
      and(
        eq(unitCostThresholdEvents.metricId, metricId),
        eq(unitCostThresholdEvents.thresholdKey, thresholdKey),
        eq(unitCostThresholdEvents.labelValue, labelValue),
        eq(unitCostThresholdEvents.currency, currency),
        isNotNull(unitCostThresholdEvents.notifiedAt),
        gte(unitCostThresholdEvents.windowTo, addDays(windowTo, -COOLDOWN_DAYS)),
        lt(unitCostThresholdEvents.windowTo, windowTo),
      ),
    );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** "USD 0.42 per 1K request" or "24.1%": the observed value, for the message. */
function formatObserved(
  threshold: UnitCostThreshold,
  value: number,
  currency: string,
  unit: string,
): string {
  if (threshold.mode === "margin") return `${value.toFixed(1)}%`;
  const scale = toUnitCostScale(threshold.scale);
  return `${formatUnitCostValue(value, "unit_cost")} ${unitCostUnitLabel({ unit }, "unit_cost", currency, scale)}`;
}

/**
 * Evaluate every threshold on every live metric of an org, and notify fresh
 * breaches. Errors are logged, never thrown: this must not break the poller.
 */
export async function evaluateUnitCostThresholdsForOrg(
  organizationId: string,
  now = new Date(),
  force = false,
): Promise<void> {
  const at = now.getTime();
  const last = lastEvaluatedAt.get(organizationId);
  if (!force && last !== undefined && at - last < MIN_EVAL_INTERVAL_MS) return;
  lastEvaluatedAt.set(organizationId, at);

  let rows: Array<typeof businessMetrics.$inferSelect>;
  try {
    rows = await db
      .select()
      .from(businessMetrics)
      .where(
        and(
          eq(businessMetrics.organizationId, organizationId),
          isNull(businessMetrics.deletedAt),
          sql`jsonb_array_length(${businessMetrics.thresholds}) > 0`,
        ),
      )
      .orderBy(businessMetrics.createdAt)
      .limit(MAX_METRICS_PER_PASS);
  } catch (err) {
    console.error(`[unit-cost-threshold] metric read failed for org ${organizationId}:`, err);
    return;
  }
  if (rows.length === 0) return;

  // The org's display currency, when it has one, so a unit-cost threshold is
  // judged in the currency people read it in. Failure degrades to
  // per-currency judgement, the regression evaluator's policy.
  let displayCurrency: string | undefined;
  try {
    displayCurrency = (await getOrgCurrencySettings(organizationId)).displayCurrency ?? undefined;
  } catch (err) {
    console.error(`[unit-cost-threshold] currency read failed for org ${organizationId}:`, err);
  }

  // Yesterday is the newest complete day on both sides of the ratio.
  const windowTo = addDays(isoDay(now), -1);
  const url = orgAppUrl(organizationId, "costs");

  for (const row of rows) {
    const metric = metricDefFromRow(row);
    const thresholds = (row.thresholds ?? []) as UnitCostThreshold[];
    for (const threshold of thresholds) {
      try {
        const windowDays = threshold.windowDays ?? DEFAULT_UNIT_COST_THRESHOLD_WINDOW_DAYS;
        const windowFrom = addDays(windowTo, -(windowDays - 1));
        const scale = toUnitCostScale(threshold.scale);
        const response = await runUnitCostCalculation(organizationId, metric, {
          from: windowFrom,
          to: windowTo,
          binning: "daily",
          mode: threshold.mode,
          ...(threshold.mode === "unit_cost" && scale !== 1 ? { scale } : {}),
          ...(threshold.groupByLabel ? { groupByLabel: threshold.groupByLabel } : {}),
          ...(displayCurrency && threshold.mode === "unit_cost" ? { displayCurrency } : {}),
        });
        const key = unitCostThresholdKey(threshold);
        for (const breach of judgeUnitCostThreshold(threshold, response, windowDays)) {
          const [inserted] = await db
            .insert(unitCostThresholdEvents)
            .values({
              id: randomUUID(),
              organizationId,
              metricId: metric.id,
              thresholdKey: key,
              mode: threshold.mode,
              direction: threshold.direction,
              thresholdValue: threshold.value,
              scale,
              labelKey: threshold.groupByLabel ?? "",
              labelValue: breach.labelValue,
              currency: breach.currency,
              windowFrom,
              windowTo,
              observedValue: breach.observed,
              windowSpend: breach.windowSpend,
            })
            .onConflictDoNothing()
            .returning({ id: unitCostThresholdEvents.id });
          if (!inserted) continue;
          if (await inCooldown(metric.id, key, breach.labelValue, breach.currency, windowTo)) {
            continue;
          }

          const observed = formatObserved(threshold, breach.observed, breach.currency, metric.unit);
          const who = threshold.groupByLabel
            ? ` for ${threshold.groupByLabel}=${breach.labelValue || "(no label)"}`
            : "";
          const routed = await routeAlert({
            organizationId,
            trigger: "unitCostRegressionAlerts",
            title: `${threshold.mode === "margin" ? "Margin" : "Unit cost"} ${threshold.direction} limit: ${metric.name}${who}`,
            body:
              `infrawrench unit-cost threshold: "${metric.name}"${who} is at ${observed} over ` +
              `${windowFrom}–${windowTo}, ${threshold.direction} the limit you set ` +
              `(${describeUnitCostThreshold(threshold, metric)}). Spend in the window was ` +
              `${breach.windowSpend.toFixed(2)} ${breach.currency}.`,
            context: `${windowFrom}–${windowTo}`,
            url,
            pushData: {
              type: "unit_cost_threshold",
              orgId: organizationId,
              metricId: metric.id,
              windowTo,
              currency: breach.currency,
              labelValue: breach.labelValue,
            },
            // The window's spend, like the regression: a routing rule on size
            // means "how much money is behind this", never a sub-cent ratio.
            facts: {
              amountCents: Math.round(breach.windowSpend * 100),
              currency: breach.currency,
              key: metric.key,
            },
          });
          if (alertReached(routed)) {
            await db
              .update(unitCostThresholdEvents)
              .set({ notifiedAt: new Date() })
              .where(eq(unitCostThresholdEvents.id, inserted.id));
          }
        }
      } catch (err) {
        // A threshold whose label lost its mapping, or whose saved filter
        // broke, is skipped for the pass rather than judged against the
        // wrong spend; the chart shows the same error to whoever looks.
        const level = err instanceof UnitCostRunError ? "warn" : "error";
        console[level](`[unit-cost-threshold] metric ${metric.key} threshold failed:`, err);
      }
    }
  }
}
