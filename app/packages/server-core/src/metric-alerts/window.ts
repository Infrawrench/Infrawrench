/**
 * The pure half of metric alert evaluation: given the per-minute samples of
 * one series on one resource, decide whether the rule's condition held for
 * the whole trailing window. No I/O, no clock reads — everything a test needs
 * comes in as arguments (the `anomaly-detect.ts` stance).
 *
 * "Held for the whole window" is judged over the samples that exist, plus a
 * coverage requirement that keeps sparse data honest:
 *
 * - any sample inside the window that does NOT breach → `cleared`
 * - no samples at all → `no_data` (a gap is not evidence either way)
 * - all samples breach, but there are too few of them or they cluster in one
 *   corner of the window → `insufficient` — an open firing stays open, but a
 *   new one is not opened on that little evidence
 * - all samples breach, with enough of them spread across the window →
 *   `breaching`
 */

export type MetricComparator = ">" | ">=" | "<" | "<=";

export interface WindowSample {
  tsMs: number;
  value: number;
}

export type WindowVerdict =
  | { state: "breaching"; /** Worst breaching sample, in the metric's unit. */ observed: number }
  | { state: "insufficient" }
  | { state: "cleared" }
  | { state: "no_data" };

/**
 * Fewest per-minute samples that can claim "held for the whole window".
 * Metrics land on the resource poll cadence, so a window's minute buckets are
 * usually well populated; three is the floor below which a single noisy poll
 * could open an incident on its own.
 */
export const MIN_WINDOW_SAMPLES = 3;

export function compareMetric(value: number, comparator: MetricComparator, threshold: number) {
  switch (comparator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
  }
}

export interface JudgeWindowOptions {
  comparator: MetricComparator;
  threshold: number;
  /** Width of the trailing window, ms (`forMinutes * 60_000`). */
  windowMs: number;
  /** The window's right edge, epoch ms. */
  nowMs: number;
}

/**
 * Judge one resource's samples against the rule. Samples outside
 * `(nowMs - windowMs, nowMs]` are ignored, so the caller may pass a wider
 * read unfiltered.
 *
 * The coverage requirement for `breaching`: at least {@link MIN_WINDOW_SAMPLES}
 * breaching samples, the earliest of them inside the window's first two
 * thirds, and the freshest inside its last third. That is what separates
 * "the condition held for the whole window" from "the condition held for the
 * two minutes we happen to have data for".
 */
export function judgeWindow(
  samples: readonly WindowSample[],
  options: JudgeWindowOptions,
): WindowVerdict {
  const { comparator, threshold, windowMs, nowMs } = options;
  const fromMs = nowMs - windowMs;

  let count = 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  let observed: number | null = null;
  for (const s of samples) {
    if (s.tsMs <= fromMs || s.tsMs > nowMs) continue;
    if (!compareMetric(s.value, comparator, threshold)) return { state: "cleared" };
    count += 1;
    if (s.tsMs < earliest) earliest = s.tsMs;
    if (s.tsMs > latest) latest = s.tsMs;
    // "Worst" is the sample deepest past the threshold, which for the two
    // upper-bound comparators is the max and for the lower-bound ones the min.
    if (
      observed === null ||
      (comparator === ">" || comparator === ">=" ? s.value > observed : s.value < observed)
    ) {
      observed = s.value;
    }
  }

  if (count === 0) return { state: "no_data" };
  const coverageOk =
    count >= MIN_WINDOW_SAMPLES &&
    earliest <= fromMs + (windowMs * 2) / 3 &&
    latest >= nowMs - windowMs / 3;
  if (!coverageOk) return { state: "insufficient" };
  return { state: "breaching", observed: observed as number };
}
