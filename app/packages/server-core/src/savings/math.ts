/**
 * Realized savings: the arithmetic. Pure and db-free; `realized.ts` gathers
 * what these functions need and `__tests__/savings-math.test.ts` pins the
 * rules down.
 *
 * ## The rules, all of which are load-bearing
 *
 * - **The action day is in neither window** (except for a manual entry, which
 *   names the day the saving began). On the day of a resize the resource is
 *   billed partly at each size, which would drag the baseline down and the
 *   first realized day up.
 * - **Baseline days are days inside collection coverage**, zero-filled there
 *   and absent outside it. A baseline needs at least
 *   {@link MIN_BASELINE_DAYS} such days and a positive mean; otherwise billing
 *   cannot say what the resource cost and the estimate takes over.
 * - **A realized day is a day collection covered.** Days the account has not
 *   been collected for yet are not accrued at all, so a fresh action reads
 *   "waiting for billing", never "saved nothing".
 * - **Negative days count.** A resource that grew back costs more than its
 *   baseline and the realized figure goes down accordingly; clamping each day
 *   at zero would report savings nobody made.
 * - **Recurring actions have no horizon.** A sleep schedule saves for as long
 *   as it runs; a one-off resize stops accruing at the horizon, because a year
 *   later the old size is no longer the honest counterfactual.
 * - **Period-native providers are never measured from billing.** They date a
 *   whole invoice to the period start, so a daily baseline is meaningless
 *   (`cost/change-impact.ts` refuses them for the same reason).
 */
import {
  AVERAGE_DAYS_PER_MONTH,
  type AllocationRule,
  type RealizedSavingsBasis,
  type RealizedSavingsBucket,
  type RealizedSavingsMonth,
  type RealizedSavingsTotal,
  type SavingsEventKind,
  type SavingsEventStatus,
  type SavingsShortfall,
} from "@infrawrench/client-core";
import { addDays, daysBetween } from "../cost/dates";

/** Fewest covered pre-action days a billing baseline may rest on. */
export const MIN_BASELINE_DAYS = 3;
/** Trailing accrued days the current run-rate and the shortfall test read. */
export const RUN_RATE_DAYS = 7;
/** Accrued days before a shortfall may be flagged at all. */
export const MIN_SHORTFALL_DAYS = 3;

export interface DailySeries {
  currency: string;
  points: Array<{ day: string; amount: number }>;
}

export interface RealizationInput {
  kind: SavingsEventKind;
  occurredOn: string;
  endedOn: string | null;
  /** One-off horizon in days; null means the action recurs and never stops by age. */
  horizonDays: number | null;
  /** Today (UTC); always partial, so never accrued. */
  today: string;
  /** Inclusive report range. */
  range: { from: string; to: string };
  baselineWindowDays: number;
  /** 0–1. */
  shortfallThreshold: number;
  /** The account's collected day span, or null when nothing was ever collected. */
  coverage: { firstDay: string; lastDay: string } | null;
  /** This resource's daily spend, one series per currency. */
  series: DailySeries[];
  costAddressable: boolean;
  periodNative: boolean;
  projectedMonthly: number | null;
  currency: string | null;
  baselineDailyEstimate: number | null;
  postDailyEstimate: number | null;
  offFraction: number | null;
  /** True for manual entries: realized falls back to the logged amount. */
  manual: boolean;
}

export interface RealizationResult {
  basis: RealizedSavingsBasis;
  status: SavingsEventStatus;
  realizedCurrency: string | null;
  baselinePerDay: number | null;
  currentPerDay: number | null;
  realizedToDate: number | null;
  realizedInRange: number | null;
  projectedInRange: number | null;
  accruedDays: number;
  horizonEndsOn: string | null;
  shortfall: SavingsShortfall | null;
  /** Per month inside the range: realized and projected over accrued days. */
  months: Array<{ month: string; realized: number; projected: number }>;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function minDay(...days: Array<string | null>): string | null {
  let out: string | null = null;
  for (const d of days) if (d !== null && (out === null || d < out)) out = d;
  return out;
}

function maxDay(...days: Array<string | null>): string | null {
  let out: string | null = null;
  for (const d of days) if (d !== null && (out === null || d > out)) out = d;
  return out;
}

/** The series carrying the most spend: one currency per measurement, never mixed. */
function dominantSeries(series: DailySeries[]): DailySeries | null {
  let best: DailySeries | null = null;
  let bestTotal = -Infinity;
  for (const s of series) {
    const total = s.points.reduce((sum, p) => sum + Math.abs(p.amount), 0);
    if (total > bestTotal) {
      best = s;
      bestTotal = total;
    }
  }
  return best;
}

/** Inclusive day list. Empty when `from > to`. */
function daysIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Last day an event may accrue on, or null when it recurs. A horizon of N days
 * starting the day after the action ends on day `T + N`.
 */
export function horizonEnd(occurredOn: string, horizonDays: number | null): string | null {
  if (horizonDays === null) return null;
  return addDays(occurredOn, Math.max(1, Math.round(horizonDays)));
}

/** Months → days, on the same average month the schedule projections use. */
export function horizonMonthsToDays(months: number): number {
  return Math.round(months * AVERAGE_DAYS_PER_MONTH);
}

function statusFor(
  input: RealizationInput,
  horizonEndsOn: string | null,
  basis: RealizedSavingsBasis,
  accruedDays: number,
): SavingsEventStatus {
  if (input.endedOn !== null && input.endedOn < input.today) return "ended";
  if (horizonEndsOn !== null && horizonEndsOn < input.today) return "complete";
  if (basis === "unmeasured") return "pending";
  if (basis === "billing" && accruedDays === 0) return "pending";
  return "accruing";
}

/** Compute one event's realized saving. */
export function computeRealization(input: RealizationInput): RealizationResult {
  const projectedDaily =
    input.projectedMonthly !== null && input.projectedMonthly > 0
      ? input.projectedMonthly / AVERAGE_DAYS_PER_MONTH
      : null;
  const horizonEndsOn = horizonEnd(input.occurredOn, input.horizonDays);
  const yesterday = addDays(input.today, -1);
  const accrualStart = input.manual ? input.occurredOn : addDays(input.occurredOn, 1);
  const accrualEnd = minDay(yesterday, input.endedOn, horizonEndsOn)!;

  // --- Billing basis -------------------------------------------------------
  const series = input.costAddressable && !input.periodNative ? dominantSeries(input.series) : null;
  if (series && input.coverage) {
    const byDay = new Map<string, number>();
    for (const p of series.points) byDay.set(p.day, (byDay.get(p.day) ?? 0) + p.amount);

    const baselineFrom = maxDay(
      addDays(input.occurredOn, -input.baselineWindowDays),
      input.coverage.firstDay,
    )!;
    const baselineTo = minDay(addDays(input.occurredOn, -1), input.coverage.lastDay)!;
    const baselineDays = daysIn(baselineFrom, baselineTo);
    const baselineTotal = baselineDays.reduce((sum, d) => sum + (byDay.get(d) ?? 0), 0);
    const baselinePerDay =
      baselineDays.length >= Math.min(MIN_BASELINE_DAYS, input.baselineWindowDays)
        ? baselineTotal / baselineDays.length
        : null;

    if (baselinePerDay !== null && baselinePerDay > 0) {
      const coveredEnd = minDay(accrualEnd, input.coverage.lastDay)!;
      const coveredStart = maxDay(accrualStart, input.coverage.firstDay)!;
      const accrued = daysIn(coveredStart, coveredEnd);
      const sameCurrency = input.currency === null || input.currency === series.currency;
      const projectedForBilling = sameCurrency ? projectedDaily : null;
      const actual = (d: string) => byDay.get(d) ?? 0;
      return finish(input, {
        basis: "billing",
        realizedCurrency: series.currency,
        baselinePerDay,
        accrued,
        realizedOn: (d) => baselinePerDay - actual(d),
        actualOn: actual,
        projectedDaily: projectedForBilling,
        horizonEndsOn,
        canFallShort: true,
      });
    }
  }

  // --- Estimate / manual basis ---------------------------------------------
  const accrued = daysIn(accrualStart, accrualEnd);
  const estimate = estimatedDaily(input, projectedDaily);
  if (estimate !== null) {
    return finish(input, {
      basis: input.manual ? "manual" : "estimate",
      realizedCurrency: input.currency,
      baselinePerDay: input.baselineDailyEstimate,
      accrued,
      realizedOn: () => estimate.realized,
      actualOn: estimate.current === null ? null : () => estimate.current!,
      projectedDaily,
      horizonEndsOn,
      canFallShort: false,
    });
  }

  return {
    basis: "unmeasured",
    status: statusFor(input, horizonEndsOn, "unmeasured", 0),
    realizedCurrency: null,
    baselinePerDay: null,
    currentPerDay: null,
    realizedToDate: null,
    realizedInRange: null,
    projectedInRange: null,
    accruedDays: 0,
    horizonEndsOn,
    shortfall: null,
    months: [],
  };
}

/**
 * Per-day realized saving when billing cannot measure it, and the post-action
 * daily cost that implies. Null when there is nothing to estimate from.
 */
function estimatedDaily(
  input: RealizationInput,
  projectedDaily: number | null,
): { realized: number; current: number | null } | null {
  if (input.manual) {
    return projectedDaily === null ? null : { realized: projectedDaily, current: null };
  }
  const base = input.baselineDailyEstimate;
  switch (input.kind) {
    case "orphan_deletion":
      if (base !== null) return { realized: base, current: 0 };
      break;
    case "rightsizing":
      if (base !== null && input.postDailyEstimate !== null) {
        return { realized: base - input.postDailyEstimate, current: input.postDailyEstimate };
      }
      break;
    case "sleep_schedule":
      if (base !== null && input.offFraction !== null) {
        // Hours off × the hourly rate: what the schedule is *designed* to save.
        return {
          realized: base * input.offFraction,
          current: base * (1 - input.offFraction),
        };
      }
      break;
    default:
      break;
  }
  return projectedDaily === null ? null : { realized: projectedDaily, current: null };
}

interface FinishArgs {
  basis: RealizedSavingsBasis;
  realizedCurrency: string | null;
  baselinePerDay: number | null;
  accrued: string[];
  realizedOn: (day: string) => number;
  actualOn: ((day: string) => number) | null;
  projectedDaily: number | null;
  horizonEndsOn: string | null;
  canFallShort: boolean;
}

function finish(input: RealizationInput, a: FinishArgs): RealizationResult {
  let toDate = 0;
  let inRange = 0;
  let projectedInRange = 0;
  const months = new Map<string, { realized: number; projected: number }>();
  for (const d of a.accrued) {
    const r = a.realizedOn(d);
    toDate += r;
    if (d >= input.range.from && d <= input.range.to) {
      inRange += r;
      const p = a.projectedDaily ?? 0;
      projectedInRange += p;
      const month = d.slice(0, 7);
      const m = months.get(month) ?? { realized: 0, projected: 0 };
      m.realized += r;
      m.projected += p;
      months.set(month, m);
    }
  }

  const trailing = a.accrued.slice(-RUN_RATE_DAYS);
  const currentPerDay =
    a.actualOn && trailing.length > 0
      ? trailing.reduce((sum, d) => sum + a.actualOn!(d), 0) / trailing.length
      : null;

  let shortfall: SavingsShortfall | null = null;
  if (
    a.canFallShort &&
    a.baselinePerDay !== null &&
    currentPerDay !== null &&
    a.accrued.length >= MIN_SHORTFALL_DAYS
  ) {
    const realizedPerDay = a.baselinePerDay - currentPerDay;
    if (currentPerDay > a.baselinePerDay) {
      shortfall = {
        kind: "grew_back",
        realizedPerDay: round2(realizedPerDay),
        projectedPerDay: a.projectedDaily === null ? null : round2(a.projectedDaily),
      };
    } else if (
      a.projectedDaily !== null &&
      realizedPerDay < input.shortfallThreshold * a.projectedDaily
    ) {
      shortfall = {
        kind: "below_projection",
        realizedPerDay: round2(realizedPerDay),
        projectedPerDay: round2(a.projectedDaily),
      };
    }
  }

  return {
    basis: a.basis,
    status: statusFor(input, a.horizonEndsOn, a.basis, a.accrued.length),
    realizedCurrency: a.realizedCurrency,
    baselinePerDay: a.baselinePerDay === null ? null : round2(a.baselinePerDay),
    currentPerDay: currentPerDay === null ? null : round2(currentPerDay),
    realizedToDate: round2(toDate),
    realizedInRange: round2(inRange),
    projectedInRange: a.projectedDaily === null ? null : round2(projectedInRange),
    accruedDays: a.accrued.length,
    horizonEndsOn: a.horizonEndsOn,
    shortfall,
    months: [...months.entries()]
      .sort(([x], [y]) => (x < y ? -1 : 1))
      .map(([month, m]) => ({
        month,
        realized: round2(m.realized),
        projected: round2(m.projected),
      })),
  };
}

/* ------------------------------------------------------------------ *
 * Commitments
 * ------------------------------------------------------------------ */

export interface CommitmentRealizationInput {
  /** −Σ cash `commitment_discount` per day: the on-demand value the plan offset. */
  discountByDay: Map<string, number>;
  /** Σ amortized `commitment_fee` per day: what the plan cost that day. */
  feeByDay: Map<string, number>;
  range: { from: string; to: string };
}

/**
 * A commitment's realized saving is the on-demand value it offset minus what
 * it cost, per day: the discount line the provider writes against covered
 * usage, less the amortized fee.
 *
 * Only days that carry a discount line are counted. A reservation whose
 * discount is baked into the rate (AWS RIs) writes no such line, so its fee
 * alone would read as a loss; counting fee-only days would turn "we cannot see
 * this plan's discount" into "this plan costs money", which is the wrong
 * direction to be wrong in.
 */
export function computeCommitmentRealization(input: CommitmentRealizationInput): {
  realized: number;
  discount: number;
  fee: number;
  measuredDays: number;
  firstDay: string | null;
  months: Array<{ month: string; realized: number }>;
} {
  let realized = 0;
  let discount = 0;
  let fee = 0;
  let measuredDays = 0;
  let firstDay: string | null = null;
  const months = new Map<string, number>();
  for (const [day, d] of [...input.discountByDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (day < input.range.from || day > input.range.to || d <= 0) continue;
    const f = input.feeByDay.get(day) ?? 0;
    const r = d - f;
    realized += r;
    discount += d;
    fee += f;
    measuredDays += 1;
    firstDay ??= day;
    const month = day.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + r);
  }
  return {
    realized: round2(realized),
    discount: round2(discount),
    fee: round2(fee),
    measuredDays,
    firstDay,
    months: [...months.entries()].map(([month, r]) => ({ month, realized: round2(r) })),
  };
}

/* ------------------------------------------------------------------ *
 * Cost-centre attribution
 * ------------------------------------------------------------------ */

/**
 * The cost centre an event lands in under the org's allocation rules, first
 * match wins (rules already in `orderAllocationRules` order).
 *
 * The same vocabulary the showback `multiIf` matches cost rows on, evaluated
 * here against the event's snapshot. A rule that names a `service` never
 * matches: an action is about a resource, not a service line, and guessing
 * which service a resource bills under would invent an attribution.
 */
export function attributeCostCentre(
  rules: readonly AllocationRule[],
  subject: {
    accountId: string | null;
    pluginId: string | null;
    tags: Record<string, string> | null;
  },
): string | null {
  for (const rule of rules) {
    const m = rule.match;
    if (m.service) continue;
    if (m.accountId && m.accountId !== subject.accountId) continue;
    if (m.pluginId && m.pluginId !== subject.pluginId) continue;
    if (m.tagKey) {
      const value = subject.tags?.[m.tagKey];
      if (value === undefined) continue;
      if (m.tagValue !== undefined && m.tagValue !== value) continue;
    }
    if (!m.accountId && !m.pluginId && !m.tagKey) continue;
    return rule.costCentreId;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

export interface AggregatableResult {
  kind: SavingsEventKind;
  basis: RealizedSavingsBasis;
  realizedCurrency: string | null;
  currency: string | null;
  realizedInRange: number | null;
  projectedInRange: number | null;
  months: Array<{ month: string; realized: number; projected: number }>;
  accountId: string | null;
  accountName: string | null;
  attributedCostCentreId: string | null;
  attributedCostCentreName: string | null;
}

export interface RealizedSavingsAggregate {
  totals: RealizedSavingsTotal[];
  byMonth: RealizedSavingsMonth[];
  byKind: RealizedSavingsBucket[];
  byCostCentre: RealizedSavingsBucket[];
  byAccount: RealizedSavingsBucket[];
}

/**
 * Totals and the three breakdowns, per currency. Unmeasured events add
 * nothing anywhere (they are counted separately by the caller); a projection
 * is summed under the event's own currency, a realized figure under the
 * currency billing reported it in.
 */
export function aggregateRealizedSavings(
  results: readonly AggregatableResult[],
  kindLabel: (kind: SavingsEventKind) => string,
): RealizedSavingsAggregate {
  const totals = new Map<string, RealizedSavingsTotal>();
  const months = new Map<string, RealizedSavingsMonth>();
  const buckets = {
    kind: new Map<string, RealizedSavingsBucket>(),
    centre: new Map<string, RealizedSavingsBucket>(),
    account: new Map<string, RealizedSavingsBucket>(),
  };

  const bump = (
    map: Map<string, RealizedSavingsBucket>,
    key: string,
    label: string,
    currency: string,
    realized: number,
    projected: number,
    countEvent: boolean,
  ) => {
    const id = `${key} ${currency}`;
    const b = map.get(id) ?? { key, label, currency, realized: 0, projected: 0, events: 0 };
    b.realized += realized;
    b.projected += projected;
    if (countEvent) b.events += 1;
    map.set(id, b);
  };

  for (const r of results) {
    if (r.basis === "unmeasured") continue;
    const rc = r.realizedCurrency;
    const pc = r.currency ?? rc;
    const realized = r.realizedInRange ?? 0;
    const projected = r.projectedInRange ?? 0;
    const sameCurrency = rc !== null && rc === pc;

    const add = (currency: string | null, re: number, pr: number, countEvent: boolean) => {
      if (currency === null) return;
      const t = totals.get(currency) ?? { currency, realized: 0, projected: 0 };
      t.realized += re;
      t.projected += pr;
      totals.set(currency, t);
      bump(buckets.kind, r.kind, kindLabel(r.kind), currency, re, pr, countEvent);
      bump(
        buckets.centre,
        r.attributedCostCentreId ?? "",
        r.attributedCostCentreName ?? "Unallocated",
        currency,
        re,
        pr,
        countEvent,
      );
      bump(
        buckets.account,
        r.accountId ?? "",
        r.accountName ?? "No account",
        currency,
        re,
        pr,
        countEvent,
      );
    };

    if (sameCurrency) add(rc, realized, projected, true);
    else {
      add(rc, realized, 0, true);
      add(pc, 0, projected, rc === null);
    }

    for (const m of r.months) {
      if (rc !== null) {
        const key = `${m.month} ${rc}`;
        const row = months.get(key) ?? { month: m.month, currency: rc, realized: 0, projected: 0 };
        row.realized += m.realized;
        if (sameCurrency) row.projected += m.projected;
        months.set(key, row);
      }
      if (!sameCurrency && pc !== null) {
        const key = `${m.month} ${pc}`;
        const row = months.get(key) ?? { month: m.month, currency: pc, realized: 0, projected: 0 };
        row.projected += m.projected;
        months.set(key, row);
      }
    }
  }

  const roundBucket = (b: RealizedSavingsBucket): RealizedSavingsBucket => ({
    ...b,
    realized: round2(b.realized),
    projected: round2(b.projected),
  });
  const sortBuckets = (map: Map<string, RealizedSavingsBucket>) =>
    [...map.values()].map(roundBucket).sort((a, b) => b.realized - a.realized);

  return {
    totals: [...totals.values()]
      .map((t) => ({ ...t, realized: round2(t.realized), projected: round2(t.projected) }))
      .sort((a, b) => b.realized - a.realized),
    byMonth: [...months.values()]
      .map((m) => ({ ...m, realized: round2(m.realized), projected: round2(m.projected) }))
      .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0)),
    byKind: sortBuckets(buckets.kind),
    byCostCentre: sortBuckets(buckets.centre),
    byAccount: sortBuckets(buckets.account),
  };
}

/** Inclusive day count of a range; 0 when inverted. */
export function rangeDays(from: string, to: string): number {
  return from > to ? 0 : daysBetween(from, to) + 1;
}
