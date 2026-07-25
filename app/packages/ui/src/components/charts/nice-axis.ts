/**
 * Y-axis domain + tick helpers shared by the recharts-based charts.
 *
 * recharts picks ticks by insisting on a fixed tick count and stretching the
 * domain until it fits, which happily walks past zero: an all-positive bar
 * chart topping out at US$2.65 renders an axis of -US$0.90 … US$2.70. These
 * helpers choose a "nice" step first and let the tick count fall out of it,
 * so a series with no negative values always sits on a zero baseline.
 *
 * No React, no recharts imports — unit-test target.
 */

export interface AxisScale {
  domain: [number, number];
  ticks: number[];
}

/** Step sizes that read well on an axis, scaled by a power of ten. */
const STEP_MULTIPLES = [1, 2, 2.5, 5, 10];

function niceStep(rough: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const multiple = STEP_MULTIPLES.find((m) => normalized <= m + 1e-9) ?? 10;
  return multiple * magnitude;
}

/** Trim float drift (0.1 + 0.2) so it never reaches a tick label. */
function round(value: number, step: number): number {
  const decimals = Math.min(12, Math.max(0, -Math.floor(Math.log10(step)) + 1));
  return Number(value.toFixed(decimals));
}

/**
 * Zero-anchored axis over [min, max]: the domain is widened to whole steps,
 * never narrowed, and always includes zero so bar heights stay comparable.
 * `targetTicks` is a hint — the real count follows from the chosen step.
 */
export function niceAxis(min: number, max: number, targetTicks = 5): AxisScale {
  const lo = Math.min(0, Number.isFinite(min) ? min : 0);
  const rawHi = Math.max(0, Number.isFinite(max) ? max : 0);
  // All-zero (or empty) data still needs a readable axis: show 0 … 1.
  const hi = lo === 0 && rawHi === 0 ? 1 : rawHi;
  const step = niceStep((hi - lo) / Math.max(1, targetTicks - 1));

  const bottom = Math.floor(lo / step) * step;
  const top = Math.ceil(hi / step) * step;

  const ticks: number[] = [];
  for (let v = bottom; v <= top + step / 2; v += step) ticks.push(round(v, step));
  return { domain: [round(bottom, step), round(top, step)], ticks };
}

export interface RowsExtentOptions {
  /** Keys drawn as one stack — their positive and negative parts sum per row. */
  stackedKeys?: readonly string[];
  /** Keys drawn independently: unstacked bars, lines, non-stacked areas. */
  keys?: readonly string[];
}

/**
 * Min/max of the values actually plotted from recharts rows, accounting for
 * stacking (recharts stacks positives and negatives separately). Non-numeric
 * and null cells — gaps in a comparison or forecast series — are skipped.
 */
export function rowsExtent(
  rows: ReadonlyArray<Record<string, unknown>>,
  { stackedKeys = [], keys = [] }: RowsExtentOptions = {},
): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const row of rows) {
    let positives = 0;
    let negatives = 0;
    for (const key of stackedKeys) {
      const value = row[key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (value >= 0) positives += value;
      else negatives += value;
    }
    if (positives > max) max = positives;
    if (negatives < min) min = negatives;
    for (const key of keys) {
      const value = row[key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (value > max) max = value;
      if (value < min) min = value;
    }
  }
  return { min, max };
}
