/**
 * Change-based cost alert evaluation. Runs from the poller after each
 * successful cost collection for an org — the same trigger point as budget
 * and anomaly evaluation, because org cost data only changes when collection
 * runs.
 *
 * The arithmetic lives in `change-detect.ts` (pure, unit-tested — window
 * definitions, thresholds, the new/vanished-group rules); this module reads
 * the series from ClickHouse, converts currencies the org holds rates for,
 * persists what fired, and notifies through the alert routing layer under
 * the `costChangeAlerts` trigger — routing rules, quiet hours and escalation
 * apply exactly as they do to budgets and anomalies.
 *
 * ## Restatement and dedup
 *
 * Providers restate a trailing window (`DEFAULT_RESTATEMENT_DAYS` in
 * `collect.ts`), so every window is judged only once **complete** and is
 * re-judged on later passes while restated data can still change it: daily
 * alerts re-examine each of the trailing `CHANGE_EVALUATION_DAYS` complete
 * days, and the weekly/monthly windows contain the restatement horizon by
 * construction. The unique index on `cost_alert_events`
 * (alert, period, group, currency) absorbs the re-fires — an insert with
 * `onConflictDoNothing` + RETURNING says whether this firing is fresh, and
 * only fresh firings notify. That is the `budget_alert_events`
 * once-per-month protocol, applied per cadence period.
 *
 * ## Currencies
 *
 * Comparison is per (group, currency): amounts in different currencies are
 * never summed. When the org has a display currency, spend the org holds
 * rates for is converted into it first — the same `convertGroups` path the
 * budget evaluator uses — so a mixed-currency scope compares one number. A
 * currency with no rate stays in its own currency and is compared there,
 * never dropped.
 */
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { CostDimensionId } from "@infrawrench/client-core";
import { db } from "../db/client";
import { costAlertEvents, costAlerts } from "../db/schema";
import { queryCosts, type CostFilter } from "../clickhouse/cost-readers";
import { alertReached, routeAlert } from "../alerts/route";
import { convertGroups, mergeConvertedGroups } from "./currency-convert";
import { getOrgCurrencySettings, listOrgExchangeRates } from "./currency-settings";
import {
  changeWindows,
  detectChanges,
  windowTotals,
  type ChangeCadence,
  type ChangeDirection,
  type ChangeFinding,
  type ChangeWindow,
} from "./change-detect";
import { isoDay } from "./dates";

/**
 * Least time between full evaluations of one org. Same shape and reasoning
 * as the anomaly evaluator's gate: evaluation is invoked once per collected
 * account, the ClickHouse reads are the expensive half, and correctness
 * never rests on this — the events-table unique index does that — so an
 * in-process map is enough.
 */
const MIN_EVAL_INTERVAL_MS = 60 * 60 * 1000;

/** orgId → epoch ms of the last evaluation. Best-effort, per process. */
const lastEvaluatedAt = new Map<string, number>();

/** Deep link to the costs panel, where the change-alerts section lives. */
function costsUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/costs`;
}

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(cents) < 1000 ? 2 : 0,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** "+173%", "-42%", or "new" when the prior window had no spend at all. */
function deltaLabel(finding: ChangeFinding): string {
  if (finding.changePercent === null) return "new";
  return `${finding.changePercent > 0 ? "+" : ""}${finding.changePercent}%`;
}

interface ChangeAlertRow {
  id: string;
  name: string;
  filters: CostFilter[];
  groupBy: CostDimensionId | null;
  groupByTagKey: string | null;
  cadence: ChangeCadence;
  thresholdPercent: number | null;
  thresholdAmountCents: number | null;
  direction: ChangeDirection;
}

/**
 * Evaluate one alert's windows: fetch both spans in one daily-binned read,
 * convert what the org holds rates for, judge, and return what fired freshly
 * (i.e. what should notify).
 */
async function evaluateAlert(
  organizationId: string,
  alert: ChangeAlertRow,
  windows: ChangeWindow[],
  displayCurrency: string | null,
  rates: Awaited<ReturnType<typeof listOrgExchangeRates>>,
): Promise<Array<{ eventId: string; window: ChangeWindow; finding: ChangeFinding }>> {
  const fired: Array<{ eventId: string; window: ChangeWindow; finding: ChangeFinding }> = [];
  for (const window of windows) {
    // One read covers both spans — the previous window always precedes the
    // current one, so [previous.from, current.to] contains everything the
    // comparison needs (daily cadence fetches five ignored days in between,
    // which is cheaper than a second round trip).
    const raw = await queryCosts(organizationId, {
      from: window.previous.from,
      to: window.current.to,
      binning: "daily",
      groupBy: alert.groupBy ?? "none",
      ...(alert.groupByTagKey ? { groupByTagKey: alert.groupByTagKey } : {}),
      filters: alert.filters,
    });

    // Convert what the org holds rates for into its display currency, then
    // fold groups that became the same (key, currency). Currencies with no
    // rate come back untouched and are compared in their own currency.
    const { groups } = convertGroups(raw, displayCurrency, rates);
    const merged = mergeConvertedGroups(groups);

    const totals = windowTotals(merged, window.current, window.previous);
    const findings = detectChanges(totals, {
      thresholdPercent: alert.thresholdPercent,
      thresholdAmountCents: alert.thresholdAmountCents,
      direction: alert.direction,
    });

    for (const finding of findings) {
      const [inserted] = await db
        .insert(costAlertEvents)
        .values({
          id: randomUUID(),
          alertId: alert.id,
          organizationId,
          periodKey: window.periodKey,
          windowFrom: window.current.from,
          windowTo: window.current.to,
          previousFrom: window.previous.from,
          previousTo: window.previous.to,
          groupKey: finding.groupKey,
          currency: finding.currency,
          previousAmountCents: finding.previousAmountCents,
          currentAmountCents: finding.currentAmountCents,
          changePercent: finding.changePercent,
          direction: finding.direction,
        })
        .onConflictDoNothing()
        .returning({ id: costAlertEvents.id });
      if (!inserted) continue; // this period already fired for this group
      fired.push({ eventId: inserted.id, window, finding });
    }
  }
  return fired;
}

/** Human phrasing of the two spans a cadence compared. */
function windowPhrase(cadence: ChangeCadence, window: ChangeWindow): string {
  switch (cadence) {
    case "daily":
      return `on ${window.current.from} vs ${window.previous.from} (same day last week)`;
    case "weekly":
      return `over ${window.current.from}–${window.current.to} vs the prior 7 days`;
    case "monthly":
      return `so far this month (${window.current.from}–${window.current.to}) vs the same days last month`;
  }
}

/**
 * Evaluate every enabled change alert in an org and notify fresh firings
 * through the alert routing layer. Errors are logged, never thrown — like
 * budget and anomaly evaluation, this must not break the poller's cost pass.
 *
 * Rate-limited per org (`MIN_EVAL_INTERVAL_MS`); pass `force` to bypass,
 * which is what a test or an on-demand caller wants.
 */
export async function evaluateCostChangeAlertsForOrg(
  organizationId: string,
  now = new Date(),
  force = false,
): Promise<void> {
  const at = now.getTime();
  const last = lastEvaluatedAt.get(organizationId);
  if (!force && last !== undefined && at - last < MIN_EVAL_INTERVAL_MS) return;
  lastEvaluatedAt.set(organizationId, at);

  let rows;
  try {
    rows = await db
      .select()
      .from(costAlerts)
      .where(
        and(
          eq(costAlerts.organizationId, organizationId),
          eq(costAlerts.enabled, true),
          isNull(costAlerts.deletedAt),
        ),
      );
  } catch (err) {
    console.error("[change-eval] failed to load cost alerts for org", organizationId, err);
    return;
  }
  if (rows.length === 0) return;

  // Org currency settings, read once per pass. A failure degrades to
  // per-currency comparison rather than aborting the pass.
  let displayCurrency: string | null = null;
  let rates: Awaited<ReturnType<typeof listOrgExchangeRates>> = [];
  try {
    displayCurrency = (await getOrgCurrencySettings(organizationId)).displayCurrency;
    if (displayCurrency) rates = await listOrgExchangeRates(organizationId);
  } catch (err) {
    console.error(`[change-eval] currency settings read failed for org ${organizationId}:`, err);
  }

  const today = isoDay(now);
  const url = costsUrl(organizationId);

  for (const row of rows) {
    try {
      const alert: ChangeAlertRow = {
        id: row.id,
        name: row.name,
        filters: (row.filters ?? []) as CostFilter[],
        groupBy: (row.groupBy ?? null) as CostDimensionId | null,
        groupByTagKey: row.groupByTagKey ?? null,
        cadence: row.cadence,
        thresholdPercent: row.thresholdPercent,
        thresholdAmountCents: row.thresholdAmountCents,
        direction: row.direction,
      };
      // An alert with no threshold at all judges nothing — the API refuses
      // to store one, but a hand-edited row must not fire on every wobble.
      if (alert.thresholdPercent === null && alert.thresholdAmountCents === null) continue;

      const windows = changeWindows(alert.cadence, today);
      const fired = await evaluateAlert(organizationId, alert, windows, displayCurrency, rates);

      for (const { eventId, window, finding } of fired) {
        const subject =
          finding.groupKey === "" ? `"${alert.name}"` : `"${alert.name}" · ${finding.groupKey}`;
        const verb = finding.direction === "increase" ? "up" : "down";
        const body =
          `infrawrench cost change ${subject}: spend ${verb} ${deltaLabel(finding)} ` +
          `${windowPhrase(alert.cadence, window)} — ` +
          `${formatCents(finding.previousAmountCents, finding.currency)} → ` +
          `${formatCents(finding.currentAmountCents, finding.currency)}`;
        const routed = await routeAlert({
          organizationId,
          trigger: "costChangeAlerts",
          title: `Cost ${verb} ${deltaLabel(finding)}: ${finding.groupKey || alert.name}`,
          body,
          context: `${window.current.from}–${window.current.to} · ${alert.cadence}`,
          url,
          pushData: {
            type: "cost_change",
            orgId: organizationId,
            alertId: alert.id,
            periodKey: window.periodKey,
            groupKey: finding.groupKey,
          },
          // `facts` are what routing rules match on. The amount is the
          // *change*, not the total — "cost changes over $500 → #incidents"
          // means the move, which is also the number in the message.
          facts: {
            amountCents: Math.abs(finding.currentAmountCents - finding.previousAmountCents),
            currency: finding.currency,
            key: finding.groupKey || alert.name,
            ...(alert.groupBy === "provider" && finding.groupKey
              ? { pluginId: finding.groupKey }
              : {}),
          },
        });
        // `alertReached`, not `succeeded > 0`: a quiet-hours hold is a
        // delivery that has not happened yet. The events row already
        // deduplicates, so an unreached firing stays eligible for nothing —
        // `notifiedAt` is bookkeeping for the UI, not a retry gate.
        if (alertReached(routed)) {
          await db
            .update(costAlertEvents)
            .set({ notifiedAt: new Date() })
            .where(eq(costAlertEvents.id, eventId));
        }
      }

      await db
        .update(costAlerts)
        .set({ lastEvaluatedAt: new Date() })
        .where(eq(costAlerts.id, alert.id));
    } catch (err) {
      console.error(`[change-eval] cost alert ${row.id} evaluation failed:`, err);
    }
  }
}
