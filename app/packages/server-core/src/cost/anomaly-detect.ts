/**
 * Pure spend-anomaly detection maths. No I/O, no dates beyond ISO strings —
 * the evaluator (`anomaly-eval.ts`) feeds it series read from ClickHouse and
 * persists whatever it flags. Kept separate so the statistics are unit-testable
 * without a database.
 *
 * Two findings live here, and they are mutually exclusive by construction:
 *
 * - `detectSpike` — a day's spend for a (dimension, key) exceeds the trailing
 *   window's mean + `sigmas`·stddev AND exceeds the mean by at least
 *   `minDeltaAbs` units of that series' currency. The absolute floor keeps
 *   penny-noise quiet: a $0.02 day against a $0.001 baseline is many sigmas
 *   out and still not worth waking anyone for.
 * - `detectNewSpendSource` — a key that spent (effectively) nothing across the
 *   whole trailing window suddenly costs real money. No sigma bar can catch
 *   this: with an all-zero baseline the mean and stddev are both zero, so
 *   "mean + 3σ" is $0 and the observed-days guard silences the key anyway. It
 *   is also the single most valuable thing to catch — $0 to $5,000 is how a
 *   leaked key or a fat-fingered instance type shows up — so it gets its own
 *   absolute floor instead of a statistical one.
 *
 * Both take their thresholds as parameters. The per-org settings that supply
 * them are read in `anomaly-eval.ts`; nothing in this file touches a database.
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
   * Minimum number of days in the baseline with any spend before a *spike* is
   * judged at all. A key that has existed for fewer days has no baseline worth
   * trusting, so `detectSpike` skips it; `detectNewSpendSource` is what
   * catches the interesting half of that population.
   *
   * It doubles as the shortest window `detectNewSpendSource` will call "no
   * prior spend" over: concluding a key is brand new from three days of
   * history would flag every key the moment cost collection started.
   */
  minBaselineDays: number;
  /**
   * Minimum first-day spend before a new spend source is reported, in the
   * units of the series being judged. A key that has never billed before and
   * now bills $0.02/day is not news.
   *
   * Stated in USD in `DEFAULT_ANOMALY_OPTIONS`, converted per series by
   * `optionsForCurrency` like `minDeltaAbs`.
   */
  minNewSourceAbs: number;
}

export const DEFAULT_ANOMALY_OPTIONS: AnomalyDetectionOptions = {
  sigmas: 3,
  /** ~$10. Denominated in USD — `optionsForCurrency` converts per series. */
  minDeltaAbs: 10,
  minBaselineDays: 7,
  /** ~$25. Higher than the spike floor — a new source has no history backing it. */
  minNewSourceAbs: 25,
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
 * `options` with its USD-denominated noise floors restated in `currency`, so a
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
  return {
    ...options,
    minDeltaAbs: options.minDeltaAbs * scale,
    minNewSourceAbs: options.minNewSourceAbs * scale,
  };
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

/** What made a day a new spend source, in the same currency units as the inputs. */
export interface DetectedNewSource {
  /** The observed amount on the day the key started spending. */
  actual: number;
  /** Everything the key spent across the whole trailing window (≈ 0). */
  baselineTotal: number;
  /** Trailing-window mean, kept so the stored row reads like a spike's. */
  mean: number;
  /** The bar the day cleared: `minNewSourceAbs`. */
  threshold: number;
}

/**
 * Decide whether `actual` is a *new spend source* against `baseline` (the same
 * zero-filled trailing series `detectSpike` takes). Returns the evidence or
 * null.
 *
 * "Effectively zero baseline" is defined as: the key spent less across the
 * *entire* trailing window than the floor for a single qualifying day. That
 * phrasing does two useful things a strict `=== 0` test does not. It tolerates
 * the rounding dust and sub-cent trial usage real billing data is full of — a
 * key that billed $0.30 over 28 days has no baseline in any meaningful sense —
 * and it scales with the floor, so it means the same thing in every currency
 * once `optionsForCurrency` has run.
 *
 * A window shorter than `minBaselineDays` returns null: with too little
 * history, "no prior spend" is a statement about the data we hold rather than
 * about the key, and every key would read as new the day collection started.
 *
 * Callers must judge `detectSpike` first and only fall through to this when it
 * returns null. In practice the two can never both fire — a baseline this
 * small has fewer than `minBaselineDays` observed days, or a mean so near zero
 * that the sigma bar is meaningless — but the ordering is what makes a
 * (day, key) exactly one kind of finding rather than a race between two.
 */
export function detectNewSpendSource(
  baseline: number[],
  actual: number,
  options: AnomalyDetectionOptions = DEFAULT_ANOMALY_OPTIONS,
): DetectedNewSource | null {
  if (baseline.length < options.minBaselineDays) return null;
  if (actual < options.minNewSourceAbs) return null;

  let baselineTotal = 0;
  for (const v of baseline) baselineTotal += v;
  if (baselineTotal >= options.minNewSourceAbs) return null;

  return {
    actual,
    baselineTotal,
    mean: meanOf(baseline),
    threshold: options.minNewSourceAbs,
  };
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
