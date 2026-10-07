/**
 * SLO evaluation: read the SLI's events from ClickHouse, compute the snapshot
 * with client-core's pure arithmetic (the same code the detail view draws
 * with), store it, and route alert transitions through the org's rules under
 * the `sloAlerts` trigger.
 *
 * Dedupe follows the house conventions:
 *
 * - An alert-level transition is a conditional `UPDATE … WHERE burn_alert =
 *   <what we read> RETURNING`: with N replicas evaluating one SLO, exactly one
 *   statement flips the row and only that replica notifies.
 * - Budget exhaustion is claimed the same way on `exhausted_at IS NULL`, so
 *   "the budget ran out" is said once per episode, not once per pass.
 * - Only escalations (none → slow, none/slow → fast) and the return to none
 *   are announced. A fast burn settling into a slow one is not news anybody
 *   needs at 03:00; the ticket-level state is on the page.
 *
 * Never throws: evaluation runs inside the poller loop.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  computeSloSnapshot,
  describeSloSource,
  formatBudgetDuration,
  formatBurnRate,
  formatSloPercent,
  formatSloTarget,
  sloBudgetTotalMinutes,
  sloMinuteBuckets,
  sloSeriesLabel,
  type SloBurnAlert,
  type SloSnapshot,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { slos } from "../db/schema";
import { getMetricMinuteSeriesBatch } from "../clickhouse/readers";
import { isClickHouseConfigured } from "../clickhouse/client";
import { getSloHourlyBuckets, type SloMinuteJudgement } from "../clickhouse/slo-readers";
import { probeMetricResourceId } from "../probes/metric-ids";
import { alertReached, routeAlert } from "../alerts/route";
import { orgAppUrl } from "../app-url";
import { loadSloSourceLabels, type SloRecord } from "./store";

/** Minute resolution is needed for the short windows; six hours covers the longest of them. */
const MINUTE_LOOKBACK_MS = 6 * 60 * 60_000;

/** Which ClickHouse identity and judgement an SLO reads. */
export function sloMetricTarget(row: SloRecord): {
  resourceId: string;
  seriesLabel: string;
  judgement: SloMinuteJudgement;
} | null {
  const seriesLabel = sloSeriesLabel(row);
  switch (row.sliKind) {
    case "probe_availability":
      if (!row.probeId) return null;
      return {
        resourceId: probeMetricResourceId(row.probeId),
        seriesLabel,
        judgement: { kind: "fraction" },
      };
    case "probe_latency":
      if (!row.probeId || row.latencyThresholdMs === null) return null;
      return {
        resourceId: probeMetricResourceId(row.probeId),
        seriesLabel,
        judgement: { kind: "threshold", comparator: "<=", threshold: row.latencyThresholdMs },
      };
    case "metric_threshold":
      if (!row.resourceId || !row.metricKey || row.comparator === null || row.threshold === null) {
        return null;
      }
      return {
        resourceId: row.resourceId,
        seriesLabel,
        judgement: { kind: "threshold", comparator: row.comparator, threshold: row.threshold },
      };
  }
}

/** Read the events and compute the snapshot. Throws on a metric-store failure. */
export async function computeSloSnapshotFor(row: SloRecord, now: Date): Promise<SloSnapshot> {
  const target = sloMetricTarget(row);
  if (!target) throw new Error("The SLO's source is incomplete.");
  const nowMs = now.getTime();
  const windowStart = nowMs - row.windowDays * 24 * 60 * 60_000;
  const [minuteMap, hourly] = await Promise.all([
    getMetricMinuteSeriesBatch(
      row.organizationId,
      [target.resourceId],
      target.seriesLabel,
      nowMs - MINUTE_LOOKBACK_MS,
      nowMs,
    ),
    getSloHourlyBuckets(
      row.organizationId,
      target.resourceId,
      target.seriesLabel,
      target.judgement,
      windowStart,
      nowMs,
    ),
  ]);
  return computeSloSnapshot({
    minuteBuckets: sloMinuteBuckets(row, minuteMap.get(target.resourceId) ?? []),
    hourlyBuckets: hourly,
    targetPercent: row.targetPercent,
    windowDays: row.windowDays,
    nowMs,
  });
}

const RANK: Record<SloBurnAlert, number> = { none: 0, slow: 1, fast: 2 };

interface SloAlertContext {
  row: SloRecord;
  sourceText: string;
  snapshot: SloSnapshot;
}

function budgetLine(row: SloRecord, snapshot: SloSnapshot): string {
  if (snapshot.budgetRemaining === null) return "no data in the window";
  const total = sloBudgetTotalMinutes(row.targetPercent, row.windowDays);
  const minutes = snapshot.budgetRemaining * total;
  const pct = `${Number((snapshot.budgetRemaining * 100).toFixed(1))}%`;
  return minutes >= 0
    ? `${pct} of the error budget left (${formatBudgetDuration(minutes)})`
    : `error budget overspent by ${formatBudgetDuration(minutes)}`;
}

function sliLine(row: SloRecord, snapshot: SloSnapshot): string {
  const sli = snapshot.sli === null ? "no data" : formatSloPercent(snapshot.sli);
  return `${sli} against a ${formatSloTarget(row.targetPercent)} target over ${row.windowDays} days`;
}

async function notifyBurn(ctx: SloAlertContext, level: Exclude<SloBurnAlert, "none">) {
  const { row, snapshot } = ctx;
  const fast = level === "fast";
  const rate1h = snapshot.burnRates["1h"];
  const rate3d = snapshot.burnRates["3d"];
  const rate = fast ? rate1h : rate3d;
  const title = fast
    ? `SLO "${row.name}" is burning its error budget fast`
    : `SLO "${row.name}" is burning its error budget`;
  const body =
    `infrawrench SLO "${row.name}" (${ctx.sourceText}): ` +
    `${rate === null || rate === undefined ? "" : `burning at ${formatBurnRate(rate)}, `}` +
    `${sliLine(row, snapshot)}; ${budgetLine(row, snapshot)}.`;
  return routeAlert({
    organizationId: row.organizationId,
    trigger: "sloAlerts",
    severity: fast ? "critical" : "warning",
    title,
    body,
    pushBody: `${budgetLine(row, snapshot)}`,
    context: `${fast ? "Fast burn" : "Slow burn"} · ${formatSloTarget(row.targetPercent)} over ${row.windowDays}d`,
    url: orgAppUrl(row.organizationId, `slos/${row.id}`),
    pushData: {
      type: "slo_alert",
      orgId: row.organizationId,
      sloId: row.id,
      status: fast ? "fast_burn" : "slow_burn",
    },
    facts: { key: row.name },
    lifecycle: { key: `slo:${row.id}`, phase: "open" },
  });
}

async function notifyRecovered(ctx: SloAlertContext) {
  const { row, snapshot } = ctx;
  return routeAlert({
    organizationId: row.organizationId,
    trigger: "sloAlerts",
    severity: "info",
    title: `SLO "${row.name}" stopped burning`,
    body:
      `infrawrench SLO "${row.name}" (${ctx.sourceText}) is back within its burn-rate limits: ` +
      `${sliLine(row, snapshot)}; ${budgetLine(row, snapshot)}.`,
    context: `Recovered · ${formatSloTarget(row.targetPercent)} over ${row.windowDays}d`,
    url: orgAppUrl(row.organizationId, `slos/${row.id}`),
    pushData: { type: "slo_alert", orgId: row.organizationId, sloId: row.id, status: "recovered" },
    facts: { key: row.name },
    lifecycle: { key: `slo:${row.id}`, phase: "resolved" },
  });
}

async function notifyExhausted(ctx: SloAlertContext) {
  const { row, snapshot } = ctx;
  const freeze = row.suggestFreeze
    ? " Consider a change freeze until the budget recovers; you can start one from the SLO's page."
    : "";
  return routeAlert({
    organizationId: row.organizationId,
    trigger: "sloAlerts",
    severity: "critical",
    title: `SLO "${row.name}" has exhausted its error budget`,
    body:
      `infrawrench SLO "${row.name}" (${ctx.sourceText}): ${sliLine(row, snapshot)}; ` +
      `${budgetLine(row, snapshot)}.${freeze}`,
    pushBody: row.suggestFreeze
      ? "Error budget spent. Consider a change freeze."
      : "Error budget spent.",
    context: `Budget exhausted · ${formatSloTarget(row.targetPercent)} over ${row.windowDays}d`,
    url: orgAppUrl(row.organizationId, `slos/${row.id}`),
    pushData: { type: "slo_alert", orgId: row.organizationId, sloId: row.id, status: "exhausted" },
    facts: { key: row.name },
  });
}

/** Settle the alert level; notify when this replica's update was the one that flipped it. */
async function settleBurnAlert(ctx: SloAlertContext, now: Date): Promise<void> {
  const { row, snapshot } = ctx;
  const previous = row.burnAlert;
  const next = snapshot.burnAlert;
  if (previous === next) return;
  const [flipped] = await db
    .update(slos)
    .set({ burnAlert: next, burnAlertChangedAt: now })
    .where(and(eq(slos.id, row.id), eq(slos.burnAlert, previous)))
    .returning({ id: slos.id });
  if (!flipped || !row.alertsEnabled) return;

  if (RANK[next] > RANK[previous]) {
    const routed = await notifyBurn(ctx, next as Exclude<SloBurnAlert, "none">);
    // Delivery failure rolls the level back so the next pass retries, the
    // `releaseUnlessDelivered` shape; a held alert counts as delivered.
    if (!alertReached(routed)) {
      await db
        .update(slos)
        .set({ burnAlert: previous })
        .where(and(eq(slos.id, row.id), eq(slos.burnAlert, next)));
    }
  } else if (next === "none") {
    await notifyRecovered(ctx);
  }
}

async function settleExhaustion(ctx: SloAlertContext, now: Date): Promise<void> {
  const { row, snapshot } = ctx;
  const exhausted = snapshot.budgetRemaining !== null && snapshot.budgetRemaining <= 0;
  if (exhausted) {
    const [claimed] = await db
      .update(slos)
      .set({ exhaustedAt: now })
      .where(and(eq(slos.id, row.id), isNull(slos.exhaustedAt)))
      .returning({ id: slos.id });
    if (!claimed || !row.alertsEnabled) return;
    const routed = await notifyExhausted(ctx);
    if (!alertReached(routed)) {
      await db
        .update(slos)
        .set({ exhaustedAt: null })
        .where(and(eq(slos.id, row.id), eq(slos.exhaustedAt, now)));
    }
  } else if (snapshot.budgetRemaining !== null) {
    await db
      .update(slos)
      .set({ exhaustedAt: null })
      .where(and(eq(slos.id, row.id), isNotNull(slos.exhaustedAt)));
  }
}

/** Store an evaluation that could not measure anything, and stand any alert down quietly. */
async function recordFailure(row: SloRecord, now: Date, message: string): Promise<void> {
  await db
    .update(slos)
    .set({ lastError: message, lastEvalAt: now, burnAlert: "none" })
    .where(eq(slos.id, row.id));
}

/** Evaluate one SLO. Never throws. */
export async function evaluateSlo(row: SloRecord, now = new Date()): Promise<void> {
  try {
    if (!isClickHouseConfigured()) {
      await recordFailure(row, now, "The metric store is not configured on this deployment.");
      return;
    }
    const labels = await loadSloSourceLabels(row.organizationId, [row]);
    if (row.probeId && !labels.probes.has(row.probeId)) {
      await recordFailure(row, now, "The probe this SLO measures was deleted.");
      return;
    }
    if (row.resourceId && !labels.resources.has(row.resourceId)) {
      await recordFailure(row, now, "The resource this SLO measures no longer exists.");
      return;
    }

    let snapshot: SloSnapshot;
    try {
      snapshot = await computeSloSnapshotFor(row, now);
    } catch (err) {
      console.error(`[slos] slo ${row.id} metric read failed:`, err);
      // Keep the last snapshot: a metric-store blip is not evidence either way.
      await db
        .update(slos)
        .set({ lastError: "The metric store could not be read.", lastEvalAt: now })
        .where(eq(slos.id, row.id));
      return;
    }

    await db
      .update(slos)
      .set({
        sli: snapshot.sli,
        goodEvents: snapshot.goodEvents,
        totalEvents: snapshot.totalEvents,
        budgetRemaining: snapshot.budgetRemaining,
        burnRates: snapshot.burnRates,
        lastError: null,
        lastEvalAt: now,
      })
      .where(eq(slos.id, row.id));

    const probe = row.probeId ? labels.probes.get(row.probeId) : undefined;
    const resource = row.resourceId ? labels.resources.get(row.resourceId) : undefined;
    const ctx: SloAlertContext = {
      row,
      snapshot,
      sourceText: describeSloSource({
        sliKind: row.sliKind,
        probeName: probe?.name ?? null,
        resourceName: resource?.displayName ?? null,
        latencyThresholdMs: row.latencyThresholdMs,
        metricKey: row.metricKey,
        comparator: row.comparator,
        threshold: row.threshold,
      }),
    };
    await settleBurnAlert(ctx, now);
    await settleExhaustion(ctx, now);
  } catch (err) {
    console.error(`[slos] slo ${row.id} evaluation failed:`, err);
  }
}
