/**
 * Y-axis domain + tick maths, shared by every surface that draws a chart:
 * recharts on web and desktop, `react-native-svg` on mobile.
 *
 * recharts picks ticks by insisting on a fixed tick count and stretching the
 * domain until it fits, which happily walks past zero: an all-positive bar
 * chart topping out at US$2.65 renders an axis of -US$0.90 … US$2.70. These
 * helpers choose a "nice" step first and let the tick count fall out of it,
 * so a series with no negative values always sits on a zero baseline.
 *
 * No React, no chart library — unit-test target.
 */

export interface AxisScale {
  domain: [number, number];
  ticks: number[];
}

/** Step sizes that read well on an axis, scaled by a power of ten. */
const STEP_MULTIPLES = [1, 2, 2.5, 5, 10];

/**
 * A negative smaller than this share of the plotted span is float drift, not
 * data: summing a day's charges against its credits in ClickHouse lands on
 * values like -2.7e-17, which must not drag the baseline off zero.
 */
const DRIFT_RATIO = 1e-9;

/**
 * Below this share of a step, a real negative gets a snug bottom rather than
 * a whole tick of its own — a US$0.02 credit should not open a US$1.00 well
 * under an axis whose bars all start at zero.
 */
const SNUG_STEP_RATIO = 0.5;

/** Granularity the snug bottom is rounded down to, as a share of a step. */
const SNUG_GRANULARITY = 0.1;

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
 *
 * How far below zero the domain runs is graded by how far the data does.
 * Drift is flattened to zero; a negative too small to earn a tick gets a snug
 * bottom and zero-based ticks, so it still renders without costing the chart
 * a whole empty step; anything larger snaps to whole steps and is labelled.
 */
export function niceAxis(min: number, max: number, targetTicks = 5): AxisScale {
  const rawLo = Math.min(0, Number.isFinite(min) ? min : 0);
  const rawHi = Math.max(0, Number.isFinite(max) ? max : 0);
  const lo = -rawLo <= Math.max(Number.MIN_VALUE, (rawHi - rawLo) * DRIFT_RATIO) ? 0 : rawLo;
  // All-zero (or empty) data still needs a readable axis: show 0 … 1.
  const hi = lo === 0 && rawHi === 0 ? 1 : rawHi;
  const step = niceStep((hi - lo) / Math.max(1, targetTicks - 1));

  const snugStep = step * SNUG_GRANULARITY;
  const bottom =
    lo === 0
      ? 0
      : -lo <= step * SNUG_STEP_RATIO
        ? Math.floor(lo / snugStep) * snugStep
        : Math.floor(lo / step) * step;
  const top = Math.ceil(hi / step) * step;

  // Ticks are always whole steps; the snug bottom sits below the first one.
  const ticks: number[] = [];
  for (let v = Math.ceil(bottom / step) * step; v <= top + step / 2; v += step) {
    ticks.push(round(v, step));
  }
  return { domain: [round(bottom, snugStep), round(top, step)], ticks };
}
