/**
 * Unit-cost regression detection — **pure**. No db, no ClickHouse, no clock,
 * no network.
 *
 * ## The signal the other cost alerts cannot see
 *
 * Budgets, anomalies and change alerts all judge a spend total against another
 * spend total, which means all three are wrong about the same two cases:
 *
 * - Spend doubled because volume tripled. Cost per customer **fell**. This is
 *   the best week the business has had, and a change alert pages someone.
 * - Spend is flat while volume halved. Cost per customer **doubled**. Nothing
 *   fires, because nothing about the spend moved.
 *
 * A unit cost is the only one of the four that gets both right, and it is the
 * number a business actually manages against.
 *
 * ## Gap semantics, restated because this is where a regression gets invented
 *
 * `cost/unit-costs.ts` establishes the rule the chart stands on: a bucket with
 * no reported metric value is a **gap**, never a zero. This module inherits it
 * and adds the consequence that only matters once you start alerting:
 *
 * > A day with no metric value contributes to **neither** side. Its spend does
 * > not enter the numerator either.
 *
 * That is rule 3 of `unit-costs.ts` ("a bucket's numerator and denominator
 * cover the same days") and here it is the difference between a finding and a
 * fabrication. Fold in the spend of a day whose volume was never reported and
 * the numerator grows while the denominator does not — a metric whose nightly
 * ingest failed for three days of a fortnight would show a unit cost up 27%
 * and page somebody about a pipeline outage dressed as a cost regression.
 *
 * The second consequence is that a window which is *mostly* gaps has no unit
 * cost at all. It does not read low, it does not read high, it reads
 * **nothing** — and a comparison against nothing is not a regression, it is a
 * missing measurement. Both windows must clear
 * {@link UnitCostRegressionOptions.minReportedDays} independently, and a
 * window that fails returns a skip reason rather than a quiet "no regression",
 * so the two cases stay distinguishable to every caller and every test.
 *
 * ## Minimum history
 *
 * A metric needs, at the shipped defaults, **28 days of history with at least
 * 10 reported days in each of the two 14-day windows** before it can produce a
 * finding. Two weeks a side covers two whole weekly cycles, so a weekday-shaped
 * unit cost compares like with like; 10 of 14 means a window is more
 * measurement than gap. A metric someone updates twice a month has no unit
 * cost to regress and will never fire, which is correct — the alert would be
 * an artefact of when the two updates landed.
 *
 * ## Currencies
 *
 * One judgement per currency, never merged. Conversion happens upstream (the
 * driver runs the same `convertGroups` path the chart does); a currency the
 * org holds no rate for keeps its own series and is compared against its own
 * prior window rather than dropped, which would understate every unit cost, or
 * added to another, which would invent one.
 */

/** An inclusive ISO-day range. */
export interface UnitCostWindow {
  from: string;
  to: string;
}

/** Daily spend for one currency, already converted and merged upstream. */
export interface UnitCostCostSeries {
  currency: string;
  /** `{ day, amount }` in any order; days outside the windows are ignored. */
  daily: Array<{ day: string; amount: number }>;
}

/** One reported day of the denominator. */
export interface UnitCostMetricDay {
  day: string;
  value: number;
}

export interface UnitCostRegressionInput {
  current: UnitCostWindow;
  /** The window `current` is judged against. Must not overlap it. */
  previous: UnitCostWindow;
  costs: UnitCostCostSeries[];
  values: UnitCostMetricDay[];
}

export interface UnitCostRegressionOptions {
  /** Percent the unit cost must rise before it is a finding. */
  thresholdPercent: number;
  /** Reported, positive metric days required in **each** window. */
  minReportedDays: number;
  /**
   * Least spend in the current window, in the units of the series being
   * judged. The caller restates its USD setting per currency the way the
   * anomaly detector does.
   */
  minCurrentSpend: number;
}

/** What one window measured. `unitCost` is null when it could not be measured. */
export interface UnitCostWindowSummary {
  /** Σcost ÷ Σvalue over the reported days only. */
  unitCost: number | null;
  /** Σcost over the reported days only — never the whole window's spend. */
  cost: number;
  /** Σvalue over the reported days. */
  metricValue: number;
  /** Days carrying a reported, positive value. */
  reportedDays: number;
  /** Days in the window that did not. */
  gapDays: number;
}

export type UnitCostRegressionSkipReason =
  /** Too few reported days in the current window to measure it at all. */
  | "insufficient_current_history"
  /** Too few reported days in the prior window to compare against. */
  | "insufficient_previous_history"
  /**
   * The prior window measured a unit cost of exactly zero (spend of nothing
   * over real volume). A rise from zero has no percentage — see the note on
   * {@link detectUnitCostRegression}.
   */
  | "no_previous_unit_cost"
  /** The current window's spend is too small to be worth reading. */
  | "spend_below_floor"
  /** The unit cost fell, or held. */
  | "improved"
  /** It rose, but by less than the threshold. */
  | "below_threshold";

export interface UnitCostRegressionFinding {
  currency: string;
  current: UnitCostWindowSummary & { unitCost: number };
  previous: UnitCostWindowSummary & { unitCost: number };
  /** Signed percent change of the unit cost. Always ≥ `thresholdPercent`. */
  changePercent: number;
}

export interface UnitCostRegressionResult {
  findings: UnitCostRegressionFinding[];
  skipped: Array<{ currency: string; reason: UnitCostRegressionSkipReason }>;
}

const DAY_MS = 86_400_000;

function addDay(day: string): string {
  return new Date(new Date(`${day}T00:00:00Z`).valueOf() + DAY_MS).toISOString().slice(0, 10);
}

/**
 * Which days of a window carry a usable denominator.
 *
 * "Usable" is `value > 0`, matching `gapFor` in `cost/unit-costs.ts`: a zero
 * denominator is the ∞ case and a negative one is the sign-flip case, and
 * neither is a number a ratio can be built from. A *zero numerator* over a
 * positive denominator is fine and is not a gap — spend of nothing over 300
 * customers genuinely is 0 per customer.
 */
function reportedDaysIn(window: UnitCostWindow, byDay: Map<string, number>): Set<string> {
  const days = new Set<string>();
  for (let day = window.from; day <= window.to; day = addDay(day)) {
    const value = byDay.get(day);
    if (value !== undefined && value > 0) days.add(day);
  }
  return days;
}

function windowDayCount(window: UnitCostWindow): number {
  let count = 0;
  for (let day = window.from; day <= window.to; day = addDay(day)) count += 1;
  return count;
}

/**
 * Summarise one window for one currency.
 *
 * Both sums run over `reported` only — the same day set on both sides, which
 * is the rule this module exists to keep. Exported so the tests can assert the
 * gap arithmetic directly rather than through a threshold.
 */
export function summarizeUnitCostWindow(
  window: UnitCostWindow,
  costByDay: Map<string, number>,
  valuesByDay: Map<string, number>,
): UnitCostWindowSummary {
  const reported = reportedDaysIn(window, valuesByDay);
  let cost = 0;
  let metricValue = 0;
  for (const day of reported) {
    cost += costByDay.get(day) ?? 0;
    metricValue += valuesByDay.get(day)!;
  }
  return {
    unitCost: metricValue > 0 ? cost / metricValue : null,
    cost,
    metricValue,
    reportedDays: reported.size,
    gapDays: windowDayCount(window) - reported.size,
  };
}

/**
 * Compare a metric's unit cost across two windows, per currency.
 *
 * The zero-previous case is a skip rather than a finding, deliberately. A rise
 * from a unit cost of exactly zero is infinite as a percentage and unbounded
 * as a headline; it also almost always means the prior window's spend had not
 * landed yet rather than that the service was genuinely free. The change-alert
 * family solved the analogous problem by calling it "new" rather than a
 * percentage, but "new" is not a thing a *unit cost* can be — the metric was
 * being reported the whole time — so there is nothing honest to say and the
 * comparison is declined.
 */
export function detectUnitCostRegression(
  input: UnitCostRegressionInput,
  options: UnitCostRegressionOptions,
): UnitCostRegressionResult {
  const findings: UnitCostRegressionFinding[] = [];
  const skipped: UnitCostRegressionResult["skipped"] = [];

  const valuesByDay = new Map<string, number>();
  for (const v of input.values) valuesByDay.set(v.day, v.value);

  for (const series of input.costs) {
    const costByDay = new Map<string, number>();
    for (const p of series.daily) {
      costByDay.set(p.day, (costByDay.get(p.day) ?? 0) + p.amount);
    }

    const current = summarizeUnitCostWindow(input.current, costByDay, valuesByDay);
    const previous = summarizeUnitCostWindow(input.previous, costByDay, valuesByDay);

    const skip = (reason: UnitCostRegressionSkipReason): void => {
      skipped.push({ currency: series.currency, reason });
    };

    // A window that is mostly gaps has no unit cost — not a low one, not a
    // high one. Checked before the ratios are looked at so a two-day window
    // that happens to divide cleanly can never become a finding.
    if (current.reportedDays < options.minReportedDays || current.unitCost === null) {
      skip("insufficient_current_history");
      continue;
    }
    if (previous.reportedDays < options.minReportedDays || previous.unitCost === null) {
      skip("insufficient_previous_history");
      continue;
    }
    if (previous.unitCost <= 0) {
      skip("no_previous_unit_cost");
      continue;
    }
    if (current.cost < options.minCurrentSpend) {
      skip("spend_below_floor");
      continue;
    }

    const changePercent = ((current.unitCost - previous.unitCost) / previous.unitCost) * 100;
    if (changePercent <= 0) {
      skip("improved");
      continue;
    }
    if (changePercent < options.thresholdPercent) {
      skip("below_threshold");
      continue;
    }

    findings.push({
      currency: series.currency,
      current: { ...current, unitCost: current.unitCost },
      previous: { ...previous, unitCost: previous.unitCost },
      changePercent,
    });
  }

  findings.sort((a, b) => b.changePercent - a.changePercent);
  return { findings, skipped };
}

/**
 * The two windows a pass compares, given the newest complete day.
 *
 * Both are complete UTC days and neither includes today: today is still
 * accruing, so its spend is a fraction of a day divided by whatever share of
 * the day's volume has been reported — a ratio of two unrelated partials. The
 * change-alert family declines the accruing day for exactly the same reason.
 */
export function unitCostWindows(
  newestCompleteDay: string,
  windowDays: number,
): { current: UnitCostWindow; previous: UnitCostWindow } {
  const back = (day: string, n: number): string =>
    new Date(new Date(`${day}T00:00:00Z`).valueOf() - n * DAY_MS).toISOString().slice(0, 10);
  const currentFrom = back(newestCompleteDay, windowDays - 1);
  const previousTo = back(currentFrom, 1);
  return {
    current: { from: currentFrom, to: newestCompleteDay },
    previous: { from: back(previousTo, windowDays - 1), to: previousTo },
  };
}
