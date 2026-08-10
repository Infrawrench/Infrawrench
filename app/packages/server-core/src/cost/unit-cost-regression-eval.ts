/**
 * Unit-cost regression evaluation — the impure half. Runs from the poller
 * after each successful cost collection for an org, the same trigger point as
 * budget, anomaly and change-alert evaluation.
 *
 * The arithmetic lives in `unit-cost-regression.ts` (pure, exhaustively
 * tested — the gap rules, the history minimum, the thresholds); this module
 * reads the numerator from ClickHouse and the denominator from Postgres,
 * converts what the org holds rates for, persists what fired, and notifies
 * through the alert routing layer under the `unitCostRegressionAlerts`
 * trigger. **Nothing here talks to a transport** — routing rules, quiet hours
 * and escalation apply exactly as they do to budgets and anomalies.
 *
 * ## The same numerator the chart draws
 *
 * A metric's unit cost is only honest if the spend divided is the spend that
 * serves the metric, so the numerator is the metric's own `costScope`
 * AND-composed with its saved filter — the same composition
 * `services/unit-cost-query.ts` performs for the chart. This module cannot
 * call that one (it lives in `@infrawrench/web`, and the poller does not
 * depend on the web app), so it composes the same two inputs from the same
 * two server-core helpers. What it deliberately does **not** do is fall back
 * to unfiltered spend when a saved filter cannot be resolved: a numerator that
 * quietly widened to the whole estate would page about a regression that is
 * an artefact of the filter breaking.
 *
 * ## Dedup, and why it needs two layers
 *
 * The windows slide daily, so a regression that persists for a fortnight is a
 * fresh `(metric, currency, windowTo)` every morning — the unique index alone
 * would alert fourteen times about one thing. So `unit_cost_regression_events`
 * carries the row (the list UI shows every firing) and a cross-day cooldown
 * decides whether it *notifies*: a metric notified inside the trailing
 * {@link COOLDOWN_DAYS} stays quiet. That is the `cost_anomalies` protocol,
 * and it counts only *notified* rows for the same two reasons it does there —
 * a suppressed row must not extend its own silence into a rolling one, and a
 * row nobody ever received must not suppress the alert that would have told
 * them.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";

import { db } from "../db/client";
import { businessMetrics, unitCostRegressionEvents } from "../db/schema";
import { queryCosts } from "../clickhouse/cost-readers";
import { alertReached, routeAlert } from "../alerts/route";
import { usdFloorIn } from "./anomaly-detect";
import { convertGroups, mergeConvertedGroups } from "./currency-convert";
import { getOrgCurrencySettings, listOrgExchangeRates } from "./currency-settings";
import { getMetricValues } from "./metric-ingest";
import { SavedCostFilterResolutionError, resolveSavedCostFilters } from "./saved-filters";
import { getOrgEfficiencySettings } from "./efficiency-settings";
import {
  detectUnitCostRegression,
  unitCostWindows,
  type UnitCostRegressionFinding,
} from "./unit-cost-regression";
import { addDays, isoDay } from "./dates";
import type { CostFilter } from "@infrawrench/client-core";

/**
 * Least time between full evaluations of one org — the anomaly and
 * change-alert gate, same shape and same reasoning. Correctness rests on the
 * unique index and the cooldown, never on this.
 */
const MIN_EVAL_INTERVAL_MS = 60 * 60 * 1000;

/** orgId → epoch ms of the last evaluation. Best-effort, per process. */
const lastEvaluatedAt = new Map<string, number>();

/**
 * Days a metric stays quiet after notifying.
 *
 * 14, matching the default window width. A unit-cost regression is a level
 * shift, not a spike: the elevated fortnight stays elevated until it rolls out
 * of both windows, so a shorter cooldown would restate the same finding every
 * morning. One cooldown-length is the point at which the comparison is against
 * genuinely different data.
 */
const COOLDOWN_DAYS = 14;

/**
 * Most metrics evaluated per org per pass.
 *
 * Each metric costs one ClickHouse read and one Postgres range read, and an
 * org may define many. The cap is generous enough that no real org hits it and
 * low enough that a pathological one cannot turn a cost collection into a
 * hundred round trips. Metrics are evaluated in creation order so the same
 * ones are covered every pass rather than an arbitrary rotation.
 */
const MAX_METRICS_PER_PASS = 50;

/** Deep link to the costs panel, where the unit-costs section lives. */
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
      maximumFractionDigits: Math.abs(amount) < 100 ? 2 : 0,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * A unit cost, formatted so a sub-cent number survives.
 *
 * `Intl` with `maximumFractionDigits: 2` renders $0.0004 per request as
 * "$0.00", which reads as free and is the same lie `unit-costs.ts` refuses to
 * chart. Below a cent the number is spelled out to four significant places
 * instead.
 */
function formatUnitCost(value: number, currency: string): string {
  const digits = Math.abs(value) >= 1 ? 2 : Math.abs(value) >= 0.01 ? 4 : 6;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${currency}`;
  }
}

interface MetricRow {
  id: string;
  key: string;
  name: string;
  unit: string;
  costScope: CostFilter[];
  savedFilterId: string | null;
}

/**
 * The metric's numerator filters: its own scope AND its saved filter.
 *
 * Returns null when the saved filter cannot be resolved — the metric is
 * skipped for the pass rather than judged against the whole estate. See the
 * module note.
 */
async function numeratorFilters(
  organizationId: string,
  metric: MetricRow,
): Promise<CostFilter[] | null> {
  const filters: CostFilter[] = [...metric.costScope];
  if (!metric.savedFilterId) return filters;
  try {
    filters.push(...(await resolveSavedCostFilters(organizationId, metric.savedFilterId)));
    return filters;
  } catch (err) {
    if (err instanceof SavedCostFilterResolutionError) {
      console.warn(
        `[unit-cost-regression] metric ${metric.key}: saved filter unresolvable, skipping —`,
        err.message,
      );
      return null;
    }
    throw err;
  }
}

/**
 * True when this metric was *notified* about within the cooldown window.
 * Stored-but-unnotified rows are ignored on purpose — see the module note.
 */
async function inCooldown(metricId: string, currency: string, windowTo: string): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(unitCostRegressionEvents)
    .where(
      and(
        eq(unitCostRegressionEvents.metricId, metricId),
        eq(unitCostRegressionEvents.currency, currency),
        isNotNull(unitCostRegressionEvents.notifiedAt),
        gte(unitCostRegressionEvents.windowTo, addDays(windowTo, -COOLDOWN_DAYS)),
        lt(unitCostRegressionEvents.windowTo, windowTo),
      ),
    );
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * The alert body: what moved, by how much, between which windows, and what to
 * look at. It names the *unit cost* first and the spend second, because the
 * whole point of this trigger is that the spend is not the story.
 */
function regressionBody(finding: UnitCostRegressionFinding, metric: MetricRow): string {
  const unit = metric.unit || "unit";
  const percent = Math.round(finding.changePercent);
  const spendDirection =
    finding.current.cost > finding.previous.cost
      ? "spend rose too"
      : finding.current.cost < finding.previous.cost
        ? "even though spend fell"
        : "on flat spend";
  return (
    `infrawrench unit-cost regression: cost per ${unit} on "${metric.name}" rose ${percent}% — ` +
    `${formatUnitCost(finding.previous.unitCost, finding.currency)} → ` +
    `${formatUnitCost(finding.current.unitCost, finding.currency)} — comparing ` +
    `${finding.current.reportedDays} reported days to ${finding.previous.reportedDays} in the ` +
    `prior window. Spend was ${formatAmount(finding.current.cost, finding.currency)} against ` +
    `${formatAmount(finding.previous.cost, finding.currency)} (${spendDirection}), on ` +
    `${finding.current.metricValue.toLocaleString("en-US")} ${unit}s against ` +
    `${finding.previous.metricValue.toLocaleString("en-US")}. ` +
    `Check what changed in this metric's cost scope before volume explains it away.`
  );
}

async function evaluateMetric(
  organizationId: string,
  metric: MetricRow,
  settings: Awaited<ReturnType<typeof getOrgEfficiencySettings>>,
  windows: ReturnType<typeof unitCostWindows>,
  displayCurrency: string | null,
  rates: Awaited<ReturnType<typeof listOrgExchangeRates>>,
  url: string | null,
): Promise<void> {
  const filters = await numeratorFilters(organizationId, metric);
  if (filters === null) return;

  // One read covers both windows: they are adjacent, so [previous.from,
  // current.to] contains everything the comparison needs.
  const raw = await queryCosts(organizationId, {
    from: windows.previous.from,
    to: windows.current.to,
    binning: "daily",
    groupBy: "none",
    filters,
  });
  const { groups } = convertGroups(raw, displayCurrency, rates);
  const merged = mergeConvertedGroups(groups);

  const values = await getMetricValues(metric.id, windows.previous.from, windows.current.to);

  // The spend floor is USD cents and is restated per currency, the same way
  // the anomaly detector scales its noise floors.
  for (const group of merged) {
    const { findings } = detectUnitCostRegression(
      {
        current: windows.current,
        previous: windows.previous,
        costs: [
          {
            currency: group.currency,
            daily: group.points.map((p) => ({ day: p.bucket, amount: p.amount })),
          },
        ],
        values,
      },
      {
        thresholdPercent: settings.unitCostThresholdPercent,
        minReportedDays: settings.unitCostMinReportedDays,
        minCurrentSpend: usdFloorIn(group.currency, settings.unitCostMinSpendCents / 100),
      },
    );

    for (const finding of findings) {
      const [inserted] = await db
        .insert(unitCostRegressionEvents)
        .values({
          id: randomUUID(),
          organizationId,
          metricId: metric.id,
          currency: finding.currency,
          windowFrom: windows.current.from,
          windowTo: windows.current.to,
          previousFrom: windows.previous.from,
          previousTo: windows.previous.to,
          previousUnitCost: finding.previous.unitCost,
          currentUnitCost: finding.current.unitCost,
          changePercent: Math.round(finding.changePercent),
          currentSpend: finding.current.cost,
          previousMetricValue: finding.previous.metricValue,
          currentMetricValue: finding.current.metricValue,
          previousReportedDays: finding.previous.reportedDays,
          currentReportedDays: finding.current.reportedDays,
        })
        .onConflictDoNothing()
        .returning({ id: unitCostRegressionEvents.id });
      if (!inserted) continue; // this window already fired for this currency

      // Stored either way; the cooldown only decides whether anyone is told.
      if (await inCooldown(metric.id, finding.currency, windows.current.to)) continue;

      const percent = Math.round(finding.changePercent);
      const routed = await routeAlert({
        organizationId,
        trigger: "unitCostRegressionAlerts",
        title: `Unit cost up ${percent}%: ${metric.name}`,
        body: regressionBody(finding, metric),
        context: `${windows.current.from}–${windows.current.to} vs ${windows.previous.from}–${windows.previous.to}`,
        url,
        pushData: {
          type: "unit_cost_regression",
          orgId: organizationId,
          metricId: metric.id,
          windowTo: windows.current.to,
          currency: finding.currency,
        },
        // The current window's spend, not the unit cost: a rule saying "unit
        // cost regressions over $10,000 → #finance" means the size of the
        // scope that regressed. A unit cost is routinely sub-cent and would
        // make every such rule match nothing.
        facts: {
          amountCents: Math.round(finding.current.cost * 100),
          currency: finding.currency,
          key: metric.key,
        },
      });
      if (alertReached(routed)) {
        await db
          .update(unitCostRegressionEvents)
          .set({ notifiedAt: new Date() })
          .where(eq(unitCostRegressionEvents.id, inserted.id));
      }
    }
  }
}

/**
 * Evaluate every live business metric in an org for a unit-cost regression and
 * notify fresh firings through the alert routing layer.
 *
 * Errors are logged, never thrown — this must not break the poller's cost
 * pass. Rate-limited per org (`MIN_EVAL_INTERVAL_MS`); pass `force` to bypass.
 */
export async function evaluateUnitCostRegressionsForOrg(
  organizationId: string,
  now = new Date(),
  force = false,
): Promise<void> {
  const at = now.getTime();
  const last = lastEvaluatedAt.get(organizationId);
  if (!force && last !== undefined && at - last < MIN_EVAL_INTERVAL_MS) return;
  lastEvaluatedAt.set(organizationId, at);

  let settings: Awaited<ReturnType<typeof getOrgEfficiencySettings>>;
  try {
    settings = await getOrgEfficiencySettings(organizationId);
  } catch (err) {
    console.error(`[unit-cost-regression] settings read failed for org ${organizationId}:`, err);
    return;
  }
  if (!settings.unitCostRegressionEnabled) return;

  let metrics: MetricRow[];
  try {
    const rows = await db
      .select({
        id: businessMetrics.id,
        key: businessMetrics.key,
        name: businessMetrics.name,
        unit: businessMetrics.unit,
        costScope: businessMetrics.costScope,
        savedFilterId: businessMetrics.savedFilterId,
        createdAt: businessMetrics.createdAt,
      })
      .from(businessMetrics)
      .where(
        and(eq(businessMetrics.organizationId, organizationId), isNull(businessMetrics.deletedAt)),
      )
      .orderBy(businessMetrics.createdAt)
      .limit(MAX_METRICS_PER_PASS);
    metrics = rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      unit: r.unit,
      costScope: (r.costScope ?? []) as CostFilter[],
      savedFilterId: r.savedFilterId,
    }));
  } catch (err) {
    console.error(`[unit-cost-regression] metric read failed for org ${organizationId}:`, err);
    return;
  }
  if (metrics.length === 0) return;

  // Org currency settings, read once per pass. A failure degrades to
  // per-currency comparison rather than aborting — the same policy the change
  // evaluator follows.
  let displayCurrency: string | null = null;
  let rates: Awaited<ReturnType<typeof listOrgExchangeRates>> = [];
  try {
    displayCurrency = (await getOrgCurrencySettings(organizationId)).displayCurrency;
    if (displayCurrency) rates = await listOrgExchangeRates(organizationId);
  } catch (err) {
    console.error(`[unit-cost-regression] currency read failed for org ${organizationId}:`, err);
  }

  // Yesterday is the newest complete day — today is still accruing on both
  // sides of the ratio and would compare a partial numerator against a partial
  // denominator.
  const windows = unitCostWindows(addDays(isoDay(now), -1), settings.unitCostWindowDays);
  const url = costsUrl(organizationId);

  for (const metric of metrics) {
    try {
      await evaluateMetric(organizationId, metric, settings, windows, displayCurrency, rates, url);
    } catch (err) {
      console.error(`[unit-cost-regression] metric ${metric.key} evaluation failed:`, err);
    }
  }
}
