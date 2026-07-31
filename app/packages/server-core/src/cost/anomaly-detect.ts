/**
 * Pure spend-anomaly detection maths. No I/O, no dates beyond ISO strings —
 * the evaluator (`anomaly-eval.ts`) feeds it series read from ClickHouse and
 * persists whatever it flags. Kept separate so the statistics are unit-testable
 * without a database.
 *
 * The model is deliberately simple for an MVP: a day's spend for a
 * (dimension, key) is an anomaly when it exceeds the trailing window's
 * mean + `sigmas`·stddev AND exceeds the mean by at least `minDeltaAbs`
 * units of that series' currency. The absolute floor keeps penny-noise quiet:
 * a $0.02 day against a $0.001 baseline is many sigmas out and still not worth
 * waking anyone for.
 */

export interface AnomalyDetectionOptions {
  /** How many standard deviations above the mean counts as anomalous. */
  sigmas: number;
  /**
   * Minimum absolute rise over the baseline mean, in the units of the series
   * being judged (not cents). Below this, no spike fires no matter how many
   * sigmas it is.
   *
   * `DEFAULT_ANOMALY_OPTIONS` states this in USD; a series billed in another
   * currency needs it converted first — see `optionsForCurrency`.
   */
  minDeltaAbs: number;
  /**
   * Minimum number of days in the baseline with any spend. A key that has
   * existed for fewer days has no baseline worth trusting, so it is skipped —
   * brand-new services announce themselves in the cost graphs instead.
   */
  minBaselineDays: number;
}

export const DEFAULT_ANOMALY_OPTIONS: AnomalyDetectionOptions = {
  sigmas: 3,
  /** ~$10. Denominated in USD — `optionsForCurrency` converts per series. */
  minDeltaAbs: 10,
  minBaselineDays: 7,
};

/**
 * Very rough units-per-USD, used *only* to keep the noise floor meaning the
 * same thing in every currency a provider might bill in.
 *
 * These are not exchange rates and must never be used as such: nothing here
 * converts a displayed amount, and a stale entry costs nothing but a slightly
 * wrong quiet threshold. Only the order of magnitude matters — the failure it
 * exists to prevent is a floor of "10 units" being ~$0.07 in JPY, which lets
 * penny noise page someone, or ~$10 in USD, which is the intent. Currencies
 * not listed fall back to 1, i.e. treated as USD-scale.
 */
const UNITS_PER_USD: Readonly<Record<string, number>> = {
  USD: 1,
  EUR: 1,
  GBP: 1,
  CHF: 1,
  CAD: 1.4,
  AUD: 1.5,
  NZD: 1.7,
  SGD: 1.3,
  ILS: 3.7,
  PLN: 4,
  BRL: 5,
  CNY: 7,
  DKK: 7,
  HKD: 7.8,
  SEK: 11,
  NOK: 11,
  MXN: 18,
  ZAR: 18,
  CZK: 23,
  TWD: 32,
  TRY: 34,
  THB: 35,
  PHP: 58,
  INR: 85,
  RUB: 90,
  JPY: 150,
  HUF: 380,
  CLP: 950,
  KRW: 1300,
  COP: 4000,
  IDR: 16000,
  VND: 25000,
};

/**
 * `options` with its USD-denominated noise floor restated in `currency`, so a
 * series billed in JPY or IDR is held to the same real threshold as one billed
 * in USD. Everything else (sigmas, baseline-day minimum) is dimensionless and
 * passes through untouched.
 */
export function optionsForCurrency(
  currency: string,
  options: AnomalyDetectionOptions = DEFAULT_ANOMALY_OPTIONS,
): AnomalyDetectionOptions {
  const scale = UNITS_PER_USD[currency.toUpperCase()] ?? 1;
  if (scale === 1) return options;
  return { ...options, minDeltaAbs: options.minDeltaAbs * scale };
}

/** What made a day anomalous, in the same currency units as the inputs. */
export interface DetectedSpike {
  /** The observed (anomalous) amount. */
  actual: number;
  /** Baseline mean over the trailing window. */
  mean: number;
  /** Baseline population standard deviation over the trailing window. */
  stddev: number;
  /** The bar the actual cleared: mean + sigmas·stddev. */
  threshold: number;
  /** actual − mean. Always ≥ minDeltaAbs when a spike is returned. */
  delta: number;
}

function meanOf(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function stddevOf(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  let sumSq = 0;
  for (const v of values) sumSq += (v - mean) * (v - mean);
  return Math.sqrt(sumSq / values.length);
}

/**
 * Decide whether `actual` is a spike against `baseline` (the trailing daily
 * amounts, oldest first, zero-filled for missing days). Returns the evidence
 * or null.
 *
 * A flat baseline (stddev 0 — e.g. a fixed daily license fee) still detects:
 * the threshold degenerates to mean + minDeltaAbs, so a genuine jump fires
 * while ordinary flatness never does.
 */
export function detectSpike(
  baseline: number[],
  actual: number,
  options: AnomalyDetectionOptions = DEFAULT_ANOMALY_OPTIONS,
): DetectedSpike | null {
  if (baseline.length === 0) return null;
  const observedDays = baseline.filter((v) => v > 0).length;
  if (observedDays < options.minBaselineDays) return null;

  const mean = meanOf(baseline);
  const stddev = stddevOf(baseline, mean);
  const threshold = mean + options.sigmas * stddev;
  const delta = actual - mean;

  if (actual <= threshold) return null;
  if (delta < options.minDeltaAbs) return null;
  return { actual, mean, stddev, threshold, delta };
}

/**
 * Zero-fill a sparse day→amount map into a dense daily array covering
 * [`fromDay`, `toDay`] inclusive, oldest first. ClickHouse only returns days
 * with rows, and a missing day is a $0 day as far as the baseline goes.
 */
export function fillDailySeries(
  byDay: ReadonlyMap<string, number>,
  fromDay: string,
  toDay: string,
): number[] {
  const out: number[] = [];
  const cursor = new Date(`${fromDay}T00:00:00.000Z`);
  const end = new Date(`${toDay}T00:00:00.000Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) return out;
  while (cursor.getTime() <= end.getTime()) {
    out.push(byDay.get(cursor.toISOString().slice(0, 10)) ?? 0);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}
