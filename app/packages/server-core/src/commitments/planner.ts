/**
 * Savings planner: which uncovered, steady workloads could a commitment
 * cover, and what would committing be worth?
 *
 * Pure and db-free. Callers aggregate uncovered usage spend per
 * `(pluginId, service, region)` cell per day over a trailing window (90 days
 * nominal, 60 minimum) and hand the series over.
 *
 * The recommendation sizes at **p10 of daily uncovered spend**, nearest-rank
 * (not interpolated): commit to the floor the workload almost never dips
 * below, not its average. A p10 commitment is idle at most ~10% of days by
 * construction, which is what makes the break-even arithmetic below hold
 * with room to spare.
 *
 * Cells pass four gates, evaluated **in this order** so the first failure
 * shown is the most actionable one:
 *
 * 1. PRESENCE — spend on ≥90% of window days. A workload that isn't there
 *    most days has nothing to commit to.
 * 2. NOT IN DECLINE — median of the recent third ≥ 0.85× median of the
 *    earlier two-thirds. Committing to a workload being wound down locks in
 *    its past.
 * 3. FLOOR — p10 ≥ 0.6×p50. A spiky workload's floor is too far below its
 *    typical day for a commitment to capture much.
 * 4. MATERIALITY — p10 × 365 ≥ 1,000 (in the cell's currency). Below that,
 *    the saving doesn't pay for the attention.
 *
 * Floor is checked *after* decline, deliberately: a workload that halved
 * mid-window fails the floor test too, and reporting it as "spiky" sends the
 * reader to smooth a workload that is actually disappearing. Keep the order.
 *
 * Published discount rates are "up to" figures — AWS Compute Savings Plans
 * up to 66% (https://aws.amazon.com/savingsplans/compute-pricing/), GCP CUDs
 * up to 55%
 * (https://cloud.google.com/compute/docs/instances/signing-up-committed-use-discounts),
 * Azure reserved instances 36–72%
 * (https://azure.microsoft.com/en-us/pricing/reserved-vm-instances/) — so
 * each recommendation carries `savingBasis` telling the renderer whether to
 * write "$X–$Y" (`range`) or "up to $X" (`upper_bound`). Never a bare "$X"
 * from an "up to" figure.
 *
 * Every row also carries the break-even sentence's numbers, because they are
 * exact, not estimates: at discount d, break-even utilization is 1−d, which
 * means the workload can shrink by d before the commitment loses money.
 * `annualLossIfUsageHalves` = max(0, C_annual × (0.5 − d)) at the *shallow*
 * end of the discount — the provider's published floor when there is one,
 * else 0 (i.e. the bound assumes no discount at all: a ceiling on regret,
 * not an estimate).
 *
 * Nothing here purchases anything, ever. The output is a briefing, and the
 * numbers on it are chosen so that acting on them requires a human who has
 * read the caveats.
 */

export type PlannerGate = "presence" | "not_in_decline" | "floor" | "materiality";

export interface PlannerCellInput {
  pluginId: string;
  service: string;
  region: string;
  currency: string;
  /** Uncovered usage spend per ISO day. Days absent from the map spent 0. */
  dailySpend: ReadonlyMap<string, number>;
}

export interface CommitmentRecommendation {
  pluginId: string;
  service: string;
  region: string;
  currency: string;
  /** p10 of daily uncovered spend — the recommended daily commitment. */
  recommendedDailyCommitment: number;
  /** The same, per hour — the unit AWS/GCP purchase forms ask for. */
  recommendedHourlyCommitment: number;
  /** recommendedDailyCommitment × 365. */
  annualCommitment: number;
  /** Context: median daily spend over the window. */
  p50DailySpend: number;
  /** "range" renders "$X–$Y"; "upper_bound" renders "up to $Y". */
  savingBasis: "range" | "upper_bound";
  /** Published discount floor, when the provider publishes one. */
  discountRateMin?: number;
  /** Published "up to" discount rate. */
  discountRateMax: number;
  /** annualCommitment × discountRateMin, when a floor is published. */
  estimatedAnnualSavingMin?: number;
  /** annualCommitment × discountRateMax — an "up to" figure. */
  estimatedAnnualSavingMax: number;
  /**
   * 1 − discountRateMax: below this utilization the commitment loses to
   * on-demand even at the best published rate. Equivalently, the workload
   * can shrink by discountRateMax before committing was a mistake.
   */
  breakEvenUtilization: number;
  /**
   * max(0, annualCommitment × (0.5 − shallowDiscount)) — worst-case annual
   * loss if the workload halves, at the shallow end of the discount (the
   * published floor, or 0 where none is published).
   */
  annualLossIfUsageHalves: number;
}

export interface PlannerRejectedCell {
  pluginId: string;
  service: string;
  region: string;
  currency: string;
  /** First gate the cell failed — the most actionable objection. */
  gate: PlannerGate;
}

export interface PlannerResult {
  /** False when the window is shorter than the 60-day minimum. */
  available: boolean;
  windowDayCount: number;
  recommendations: CommitmentRecommendation[];
  rejected: PlannerRejectedCell[];
}

/** Minimum window length: below this, p10 is noise wearing a suit. */
export const PLANNER_MIN_WINDOW_DAYS = 60;
/** Materiality floor: p10 × 365 must clear this (cell currency). */
export const PLANNER_MATERIALITY_ANNUAL = 1_000;

/**
 * Published discount figures per provider — "up to" marketing numbers, which
 * is exactly why `basis` exists. Sources in the module header.
 */
const PROVIDER_DISCOUNTS: Record<
  string,
  { min?: number; max: number; basis: "range" | "upper_bound" }
> = {
  aws: { max: 0.66, basis: "upper_bound" },
  gcp: { max: 0.55, basis: "upper_bound" },
  azure: { min: 0.36, max: 0.72, basis: "range" },
};

/** Nearest-rank percentile (deliberately not interpolated) of a sorted-ascending array. */
export function nearestRankPercentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedAscending.length));
  return sortedAscending[Math.min(rank, sortedAscending.length) - 1]!;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function evaluateCell(
  cell: PlannerCellInput,
  windowDays: readonly string[],
): CommitmentRecommendation | PlannerRejectedCell {
  const identity = {
    pluginId: cell.pluginId,
    service: cell.service,
    region: cell.region,
    currency: cell.currency,
  };
  // Ordered series over the whole window; absent days are zero-spend days.
  const series = windowDays.map((day) => cell.dailySpend.get(day) ?? 0);

  // 1. PRESENCE
  const daysWithSpend = series.filter((v) => v > 0).length;
  if (daysWithSpend < 0.9 * series.length) {
    return { ...identity, gate: "presence" };
  }

  // 2. NOT IN DECLINE — before the floor test, so a workload that halved
  // reads as declining, not as "spiky".
  const recentLength = Math.floor(series.length / 3);
  const earlier = series.slice(0, series.length - recentLength);
  const recent = series.slice(series.length - recentLength);
  if (median(recent) < 0.85 * median(earlier)) {
    return { ...identity, gate: "not_in_decline" };
  }

  const sorted = [...series].sort((a, b) => a - b);
  const p10 = nearestRankPercentile(sorted, 10);
  const p50 = nearestRankPercentile(sorted, 50);

  // 3. FLOOR
  if (p10 < 0.6 * p50) {
    return { ...identity, gate: "floor" };
  }

  // 4. MATERIALITY
  const annualCommitment = p10 * 365;
  if (annualCommitment < PLANNER_MATERIALITY_ANNUAL) {
    return { ...identity, gate: "materiality" };
  }

  const discount = PROVIDER_DISCOUNTS[cell.pluginId] ?? { max: 0, basis: "upper_bound" as const };
  // Shallow end of the discount: the published floor, else 0 — the loss
  // bound is then a ceiling on regret rather than an estimate.
  const shallow = discount.min ?? 0;

  return {
    ...identity,
    recommendedDailyCommitment: p10,
    recommendedHourlyCommitment: p10 / 24,
    annualCommitment,
    p50DailySpend: p50,
    savingBasis: discount.basis,
    ...(discount.min !== undefined ? { discountRateMin: discount.min } : {}),
    discountRateMax: discount.max,
    ...(discount.min !== undefined
      ? { estimatedAnnualSavingMin: annualCommitment * discount.min }
      : {}),
    estimatedAnnualSavingMax: annualCommitment * discount.max,
    breakEvenUtilization: 1 - discount.max,
    annualLossIfUsageHalves: Math.max(0, annualCommitment * (0.5 - shallow)),
  };
}

/**
 * Evaluate every cell against the gates. `windowDays` is the ordered,
 * inclusive list of ISO days the series cover — its length is the window,
 * and days missing from a cell's map are zero-spend days in it.
 */
export function planCommitmentRecommendations(
  cells: readonly PlannerCellInput[],
  windowDays: readonly string[],
): PlannerResult {
  if (windowDays.length < PLANNER_MIN_WINDOW_DAYS) {
    return {
      available: false,
      windowDayCount: windowDays.length,
      recommendations: [],
      rejected: [],
    };
  }

  const recommendations: CommitmentRecommendation[] = [];
  const rejected: PlannerRejectedCell[] = [];
  for (const cell of cells) {
    // Only providers with a published discount are recommendable; others
    // never even reach the gates (there is no rate to size a saving with).
    if (!PROVIDER_DISCOUNTS[cell.pluginId]) continue;
    const result = evaluateCell(cell, windowDays);
    if ("gate" in result) rejected.push(result);
    else recommendations.push(result);
  }

  recommendations.sort((a, b) => b.annualCommitment - a.annualCommitment);
  return {
    available: true,
    windowDayCount: windowDays.length,
    recommendations,
    rejected,
  };
}
