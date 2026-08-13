/**
 * Recharts-row extent helper, paired with the shared axis maths.
 *
 * `niceAxis` itself lives in `@infrawrench/client-core` — mobile draws the same
 * axes with `react-native-svg` — and is re-exported here so the recharts charts
 * keep importing one module.
 *
 * No React, no recharts imports — unit-test target.
 */

export { niceAxis } from "@infrawrench/client-core";

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
