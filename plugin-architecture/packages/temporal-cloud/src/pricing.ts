/**
 * Published Temporal Cloud list prices, used only when billed data is not
 * available (see `cost-data.ts`). Source: https://docs.temporal.io/cloud/pricing
 * (verified 2026-10):
 *
 * - Actions: $50 per million on the Developer plan at every volume. Business,
 *   Enterprise and Mission Critical get monthly volume tiers across the whole
 *   account: first 5M at $50, next 5M at $45, next 10M at $40, next 30M at
 *   $35, next 50M at $30, next 100M at $25; above 200M is negotiated, so the
 *   last published tier is carried on.
 * - Active storage $0.042 per GBh, retained storage $0.00105 per GBh.
 * - Plan: Developer is 10% of usage spend; Business is the greater of $500 a
 *   month or 10% of usage spend; Enterprise and Mission Critical are priced
 *   annually by contract, so no plan line is estimated for them.
 *
 * Every rate is user-editable on the account (credential fields), because
 * commitments and negotiated discounts change all of them.
 */

export type TemporalPlan = "developer" | "business" | "enterprise" | "none";

export interface TemporalRates {
  plan: TemporalPlan;
  /** Flat override in USD per million actions; undefined means published tiers. */
  actionsPerMillion?: number;
  activeStoragePerGbh: number;
  retainedStoragePerGbh: number;
}

export const DEFAULT_ACTIVE_STORAGE_PER_GBH = 0.042;
export const DEFAULT_RETAINED_STORAGE_PER_GBH = 0.00105;
export const BUSINESS_PLAN_MINIMUM_USD = 500;
export const PLAN_USAGE_SHARE = 0.1;

/** [ceiling in actions, USD per million] in ascending order. */
export const ACTION_TIERS: ReadonlyArray<readonly [number, number]> = [
  [5_000_000, 50],
  [10_000_000, 45],
  [20_000_000, 40],
  [50_000_000, 35],
  [100_000_000, 30],
  [Number.POSITIVE_INFINITY, 25],
];

function parseRate(raw: string | undefined, fallback: number | undefined): number | undefined {
  const text = (raw ?? "").trim().replace(/^\$/, "");
  if (text === "") return fallback;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Temporal Cloud plugin: "${raw}" is not a valid price`);
  }
  return n;
}

export function ratesFromCredentials(credentials: Record<string, string>): TemporalRates {
  const plan = (credentials["plan"] ?? "").trim().toLowerCase();
  const actions = parseRate(credentials["actionsPricePerMillion"], undefined);
  return {
    plan:
      plan === "developer" || plan === "enterprise" || plan === "none"
        ? plan
        : ("business" as TemporalPlan),
    ...(actions !== undefined ? { actionsPerMillion: actions } : {}),
    activeStoragePerGbh:
      parseRate(credentials["activeStoragePricePerGbh"], DEFAULT_ACTIVE_STORAGE_PER_GBH) ??
      DEFAULT_ACTIVE_STORAGE_PER_GBH,
    retainedStoragePerGbh:
      parseRate(credentials["retainedStoragePricePerGbh"], DEFAULT_RETAINED_STORAGE_PER_GBH) ??
      DEFAULT_RETAINED_STORAGE_PER_GBH,
  };
}

/**
 * Cost of the actions between cumulative month-to-date counts `before` and
 * `after`, so a day is priced at the tier the account had reached by then.
 */
export function actionsCost(before: number, after: number, rates: TemporalRates): number {
  if (after <= before) return 0;
  if (rates.actionsPerMillion !== undefined) {
    return ((after - before) / 1_000_000) * rates.actionsPerMillion;
  }
  if (rates.plan === "developer") return ((after - before) / 1_000_000) * 50;
  let cost = 0;
  let floor = 0;
  for (const [ceiling, price] of ACTION_TIERS) {
    const lo = Math.max(before, floor);
    const hi = Math.min(after, ceiling);
    if (hi > lo) cost += ((hi - lo) / 1_000_000) * price;
    floor = ceiling;
    if (after <= ceiling) break;
  }
  return cost;
}

/** Byte-seconds to GB-hours (decimal gigabytes, as the pricing page states them). */
export function byteSecondsToGbh(byteSeconds: number): number {
  return byteSeconds / 1e9 / 3600;
}

/**
 * The plan charge for `days` days of a month with `daysInMonth` days, given
 * the usage spend over those days. Business pro-rates its $500 minimum.
 */
export function planCost(
  usageSpend: number,
  days: number,
  daysInMonth: number,
  rates: TemporalRates,
): number {
  switch (rates.plan) {
    case "developer":
      return usageSpend * PLAN_USAGE_SHARE;
    case "business":
      return Math.max(
        (BUSINESS_PLAN_MINIMUM_USD * days) / daysInMonth,
        usageSpend * PLAN_USAGE_SHARE,
      );
    default:
      return 0;
  }
}
