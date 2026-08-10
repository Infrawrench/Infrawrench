/**
 * Unit-cost and margin arithmetic — **pure**. No db, no ClickHouse, no clock,
 * no network. Everything is a function of its arguments, which is what makes
 * the rules below exhaustively testable rather than merely asserted.
 *
 * ## The four rules
 *
 * 1. **The ratio is computed at the requested bucket, from a summed numerator
 *    and a summed denominator.** Never a mean of per-day ratios. On a week
 *    where volume moved, `mean(cost_d / units_d)` and `Σcost / Σunits` are
 *    different numbers, and only the second one is the week's unit cost — the
 *    first weights a quiet Sunday exactly as heavily as a peak Monday. The same
 *    rule applies one level up: {@link UnitCostSeries.overallValue} is
 *    `Σcost / Σunits` across buckets, not the mean of the bucket ratios.
 *
 * 2. **A missing or non-positive denominator is a gap.** `value` is `null` and
 *    {@link UnitCostPoint.gap} says which case it was. Never 0 (which reads as
 *    "that period was free"), never ±Infinity, never NaN. This is the rule the
 *    whole feature stands on: a chart that quietly reads 0 on days a metric was
 *    not reported will be believed, and it says the opposite of the truth.
 *    A *zero numerator over a positive denominator* is not a gap — spend of
 *    nothing over 300 customers genuinely is 0 per customer.
 *
 * 3. **A bucket's numerator and denominator cover the same days.** The period
 *    total therefore sums only the buckets that produced a ratio: folding spend
 *    from an unreported bucket into the numerator while its volume is missing
 *    from the denominator inflates the answer, silently, in the direction that
 *    flatters nobody.
 *
 * 4. **Currencies are never merged.** One series per currency the numerator
 *    ended up in. Spend in a currency the org has no rate for keeps its own
 *    series and divides the same denominator on its own, rather than being
 *    dropped (which understates every unit cost) or added to another currency
 *    (which invents a number).
 *
 * Partial buckets — where the denominator covers only some of the bucket's days
 * — are computed rather than discarded, because throwing away six real days of
 * volume is its own distortion. They are counted and reported so every surface
 * can say the ratio there reads high.
 */
import {
  costBucketStart,
  type CostBinningId,
  type UnitCostGapReason,
  type UnitCostMode,
  type UnitCostPoint,
  type UnitCostSeries,
} from "@infrawrench/client-core";

import { addDays } from "./dates";

/** A cost aggregate for one currency — the shape `queryCosts` returns. */
export interface UnitCostCostGroup {
  currency: string;
  points: Array<{ bucket: string; amount: number }>;
}

/** One reported day of the denominator. */
export interface UnitCostMetricValue {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  value: number;
}

export interface UnitCostComputeInput {
  /** Inclusive range, YYYY-MM-DD. */
  from: string;
  to: string;
  binning: CostBinningId;
  mode: UnitCostMode;
  /**
   * Cost aggregates, **already bucketed by `binning` and already converted**.
   * One entry per currency; conversion and merging happen upstream so this
   * module never needs a rate table.
   */
  costGroups: UnitCostCostGroup[];
  /** Daily denominator values inside the range, in any order. */
  values: UnitCostMetricValue[];
  /**
   * The currency revenue is denominated in. Required for `margin` and ignored
   * otherwise: subtracting spend from revenue is only defined in one currency,
   * so any series in a different one becomes an `unconvertible_currency` gap
   * rather than a plausible-looking wrong number.
   */
  metricCurrency: string | null;
}

export interface UnitCostComputeResult {
  series: UnitCostSeries[];
  /** Buckets on the axis where no series produced a ratio. */
  gapBuckets: number;
  /** Buckets whose denominator covers only part of the bucket. */
  partialBuckets: number;
}

/**
 * Rounding for the ratio itself.
 *
 * Ten places, not two. A unit cost is routinely sub-cent — cost per API
 * request, cost per event — and rounding to the currency's minor unit would
 * turn every such number into `0`, which reads as "free" and is the same lie as
 * rule 2's zero. Ten is far below anything a business metric can resolve and
 * far above the float noise that would otherwise put `0.30000000000000004` on
 * screen and make a reader distrust every other number on the page.
 */
const RATIO_DECIMALS = 10;

function roundRatio(value: number): number {
  const factor = 10 ** RATIO_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * Every UTC day in an inclusive range. Bounded by the caller (`runUnitCostQuery`
 * enforces the same ~3-year span limit `POST /costs/query` does), so this cannot
 * be handed an unbounded range.
 */
function daysInRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/** Per-bucket denominator state, built from the daily values. */
interface BucketDenominator {
  /** Summed metric value, or null when no day in the bucket reported one. */
  value: number | null;
  /** Days in the bucket (clipped to the range) carrying a reported value. */
  reportedDays: number;
  /** Days in the bucket that fall inside the range. */
  bucketDays: number;
}

/**
 * Fold daily values into per-bucket denominators, and produce the bucket axis.
 *
 * The axis comes from the *range*, not from the data, which is what makes an
 * interior gap visible at all: a bucket nobody reported has to exist on the axis
 * to be drawn as a hole in the line. Leading and trailing empties (a
 * month-to-date range whose last day has neither spend nor volume yet) are
 * trimmed by the caller, since those are an artefact of the range rather than a
 * fact about the data.
 *
 * `cumulative` binning shares the daily bucket boundaries and then runs a
 * running sum — over the denominator too, because the numerator `queryCosts`
 * returns for that binning is already cumulative and dividing a running total by
 * a daily one is meaningless.
 */
function buildDenominators(
  from: string,
  to: string,
  binning: CostBinningId,
  values: UnitCostMetricValue[],
): { axis: string[]; denominators: Map<string, BucketDenominator> } {
  const byDay = new Map<string, number>();
  for (const v of values) {
    if (v.day < from || v.day > to) continue;
    // Last write wins; the store's (metric, day) unique index means duplicates
    // cannot reach here from the database, but a caller passing them should not
    // silently double a day.
    byDay.set(v.day, v.value);
  }

  const axis: string[] = [];
  const denominators = new Map<string, BucketDenominator>();
  for (const day of daysInRange(from, to)) {
    const bucket = costBucketStart(day, binning);
    let entry = denominators.get(bucket);
    if (!entry) {
      entry = { value: null, reportedDays: 0, bucketDays: 0 };
      denominators.set(bucket, entry);
      axis.push(bucket);
    }
    entry.bucketDays += 1;
    const reported = byDay.get(day);
    if (reported !== undefined) {
      entry.value = (entry.value ?? 0) + reported;
      entry.reportedDays += 1;
    }
  }

  if (binning === "cumulative") {
    let runningValue: number | null = null;
    let runningReported = 0;
    let runningDays = 0;
    for (const bucket of axis) {
      const entry = denominators.get(bucket)!;
      if (entry.value !== null) runningValue = (runningValue ?? 0) + entry.value;
      runningReported += entry.reportedDays;
      runningDays += entry.bucketDays;
      entry.value = runningValue;
      entry.reportedDays = runningReported;
      entry.bucketDays = runningDays;
    }
  }

  return { axis, denominators };
}

/** The gap reason for a denominator, or null when it is usable. */
function gapFor(value: number | null): UnitCostGapReason | null {
  if (value === null) return "no_metric_value";
  // Zero is the ∞ case and a negative is the sign-flip case; both are "we
  // cannot divide by this", and neither is a number worth putting on a chart.
  if (!(value > 0)) return "non_positive_metric_value";
  return null;
}

/**
 * Compute one unit-cost (or margin) series per currency.
 *
 * See the module comment for the four rules this implements; the tests in
 * `__tests__/unit-costs.test.ts` are written against them one by one.
 */
export function computeUnitCosts(input: UnitCostComputeInput): UnitCostComputeResult {
  const { from, to, binning, mode, costGroups, values, metricCurrency } = input;
  const { axis, denominators } = buildDenominators(from, to, binning, values);

  if (costGroups.length === 0) return { series: [], gapBuckets: 0, partialBuckets: 0 };

  // Trim leading/trailing buckets that have neither spend nor a reported value.
  // Interior emptiness is preserved — that is exactly the gap the feature is
  // built to show.
  const bucketsWithSpend = new Set<string>();
  for (const group of costGroups) {
    for (const p of group.points) if (p.amount !== 0) bucketsWithSpend.add(p.bucket);
  }
  const interesting = (bucket: string): boolean =>
    bucketsWithSpend.has(bucket) || (denominators.get(bucket)?.value ?? null) !== null;
  let first = axis.findIndex(interesting);
  let last = axis.length - 1;
  while (last >= 0 && !interesting(axis[last]!)) last -= 1;
  if (first === -1 || last < first) {
    first = 0;
    last = -1;
  }
  const plotted = axis.slice(first, last + 1);

  const series: UnitCostSeries[] = costGroups.map((group) => {
    const amounts = new Map(group.points.map((p) => [p.bucket, p.amount]));
    // Margin subtracts money from money, so a series in a currency the metric
    // is not denominated in has no honest answer — every bucket is a gap that
    // names the reason, rather than a ratio nobody could reconcile.
    const currencyMismatch = mode === "margin" && group.currency !== metricCurrency;

    let overallCost = 0;
    let overallMetricValue: number | null = null;

    const points: UnitCostPoint[] = plotted.map((bucket) => {
      const denominator = denominators.get(bucket) ?? {
        value: null,
        reportedDays: 0,
        bucketDays: 0,
      };
      const cost = amounts.get(bucket) ?? 0;
      const base: Omit<UnitCostPoint, "value"> = {
        bucket,
        cost,
        metricValue: denominator.value,
        reportedDays: denominator.reportedDays,
        bucketDays: denominator.bucketDays,
      };

      const gap = currencyMismatch ? "unconvertible_currency" : gapFor(denominator.value);
      if (gap) return { ...base, value: null, gap };

      const metricValue = denominator.value!;
      // Rule 3: only buckets that produced a ratio contribute to the period
      // total, on both sides. Adding this bucket's spend while its volume was
      // missing is precisely how a period unit cost gets silently inflated.
      overallCost += cost;
      overallMetricValue = (overallMetricValue ?? 0) + metricValue;

      const ratio = mode === "margin" ? (metricValue - cost) / metricValue : cost / metricValue;
      return { ...base, value: roundRatio(ratio) };
    });

    // Rule 1, at the period level: summed numerator over summed denominator,
    // never the mean of `points[].value`.
    const overallValue =
      overallMetricValue !== null && overallMetricValue > 0
        ? roundRatio(
            mode === "margin"
              ? (overallMetricValue - overallCost) / overallMetricValue
              : overallCost / overallMetricValue,
          )
        : null;

    return {
      currency: group.currency,
      points,
      overallValue,
      overallCost,
      overallMetricValue,
    };
  });

  // Counted on the axis rather than per series: with more than one currency the
  // same missing day would otherwise be reported two or three times.
  let gapBuckets = 0;
  let partialBuckets = 0;
  for (const bucket of plotted) {
    const anyValue = series.some((s) => s.points.find((p) => p.bucket === bucket)?.value !== null);
    if (!anyValue) {
      gapBuckets += 1;
      continue;
    }
    const denominator = denominators.get(bucket);
    if (
      denominator &&
      denominator.reportedDays > 0 &&
      denominator.reportedDays < denominator.bucketDays
    ) {
      partialBuckets += 1;
    }
  }

  return { series, gapBuckets, partialBuckets };
}
