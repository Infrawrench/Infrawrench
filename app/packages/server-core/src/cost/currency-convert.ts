/**
 * Currency conversion for cost aggregates — **pure**. No db, no clock, no
 * ClickHouse, no network. Everything here is a function of its arguments, which
 * is what makes the rate-selection rules exhaustively testable.
 *
 * ## Why this is not in SQL
 *
 * Conversion happens *after* the per-currency aggregation, in application code,
 * and deliberately so:
 *
 *  - The stored rows stay untouched and auditable. `cost_daily` always holds
 *    what the provider billed, in the currency it billed in. A converted number
 *    is a presentation of that, never a replacement for it — re-stating a rate
 *    changes what you see and nothing about what was collected.
 *  - Rates vary by day. Expressing "the latest rate whose effective_from is on
 *    or before this row's day" as a join against a small table, for every row
 *    of a large one, buys a materially harder query for no benefit.
 *  - The rate table is tiny (one org's stated rates) and the aggregate is
 *    already small by the time it gets here — at most a few hundred points.
 *
 * ## The rules, in one place
 *
 *  1. **No display currency, no conversion.** Callers pass `null` and get their
 *     input back, identity-equal in shape and value.
 *  2. **Spend already in the display currency is never converted.** It is not
 *     multiplied by a rate of 1; it is passed through. A self-rate cannot exist
 *     (`buildExchangeRateTable` drops it), so nobody can scale their own
 *     currency by accident.
 *  3. **The rate that applied then.** A point dated `day` converts at the rate
 *     with the greatest `effectiveFrom <= day`. A day earlier than every stated
 *     rate for that currency has no rate — see rule 4.
 *  4. **A currency with no rate is surfaced, never dropped.** It keeps its own
 *     series and its own total, and its code lands in `unconverted`. Silently
 *     omitting it would understate the total, which is the worst failure this
 *     module could have. A currency that has *some* rates but none effective
 *     early enough for *some* points is reported as unconverted too — a
 *     partially converted series would be a number nobody could reconcile.
 *  5. **One hop only.** Rates are stated from a currency to the display
 *     currency. Nothing here inverts a rate or chains two of them; both invent
 *     a number the org never stated.
 */
import {
  buildExchangeRateTable,
  type CostConversion,
  type CostConvertedCurrency,
  type CostConversionRate,
  type ExchangeRate,
  type ExchangeRateTable,
} from "@infrawrench/client-core";

export type { CostConversion, CostConvertedCurrency, CostConversionRate };

/** The minimum a group needs for conversion — matches `CostSeriesGroup`. */
export interface ConvertibleGroup {
  currency: string;
  points: Array<{ bucket: string; amount: number }>;
  /**
   * The same buckets before the org's billing rules were applied, when the
   * query asked to be adjusted.
   *
   * Converted through exactly the same rates as `points`, on the same days,
   * because the two are compared against each other on screen: converting the
   * collected figure at the range-end rate while the adjusted one converted per
   * day would make a mid-range rate movement look like a markup.
   */
  rawPoints?: Array<{ bucket: string; amount: number }> | undefined;
}

/**
 * Money is rounded to this many decimal places after multiplying.
 *
 * Six, not two. These are aggregates that get summed again downstream (per
 * bucket, per series, into a period total), and rounding each point to the
 * cent first makes the total drift by up to half a cent per point — on a
 * 90-day daily graph that is a visibly wrong total. Six places is far below
 * any currency's minor unit and far above the accumulated error, and it keeps
 * the JSON free of the `0.30000000000000004` tails that make a reader distrust
 * every other number on the page.
 */
const AMOUNT_DECIMALS = 6;

function roundAmount(value: number): number {
  const factor = 10 ** AMOUNT_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * The rate in force on `day`, or null when the org stated none that early.
 *
 * `rates` must be sorted by `effectiveFrom` descending — `buildExchangeRateTable`
 * does that — so the first row on or before `day` is the latest one, and the
 * scan stops there. ISO `YYYY-MM-DD` compares correctly as a string, which is
 * why no dates are parsed anywhere in this module.
 */
export function rateForDay(rates: readonly ExchangeRate[], day: string): ExchangeRate | null {
  for (const rate of rates) {
    if (rate.effectiveFrom <= day) return rate;
  }
  return null;
}

/**
 * Parse a stored rate into a number for arithmetic.
 *
 * The column is `numeric`, so drizzle hands back the exact decimal string the
 * org typed and this is the only place it becomes a float. Rates live in
 * roughly 1e-5..1e5 and are used in a single multiply, so a double carries them
 * with room to spare; the reason for storing a decimal was never the
 * multiplication, it was that the value round-trips to the character.
 *
 * Anything unparseable or non-positive reads as "no rate" rather than as zero.
 * A zero rate would erase a currency's spend from the total while reporting it
 * as converted, which is exactly the silent understatement this feature exists
 * to prevent.
 */
export function parseRate(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** What `convertGroups` did, alongside the converted groups. */
export interface ConversionResult<T extends ConvertibleGroup> {
  groups: T[];
  /** Null when nothing was converted (no display currency, or nothing to do). */
  conversion: CostConversion | null;
}

/**
 * Convert every group the org holds a usable rate for into `displayCurrency`.
 *
 * Groups keep their identity — a `CostSeriesGroup` comes back a
 * `CostSeriesGroup` with the same `key`, only its `currency` and amounts
 * changed — so callers can merge same-key groups afterwards if they want one
 * series per key. Merging is left to the caller because "same key" means
 * different things to a graph (merge) and to a showback report (already keyed
 * by centre).
 *
 * A currency is converted **all or nothing**: if any of its points fall before
 * the earliest rate the org stated for it, the whole currency is left alone and
 * reported in `unconverted`. Half a converted series is a number that reconciles
 * against nothing.
 */
export function convertGroups<T extends ConvertibleGroup>(
  groups: T[],
  displayCurrency: string | null,
  rates: ExchangeRate[],
): ConversionResult<T> {
  if (!displayCurrency) return { groups, conversion: null };

  const table = buildExchangeRateTable(rates, displayCurrency);
  const present = [...new Set(groups.map((g) => g.currency))].sort();

  const convertible = new Map<string, Map<string, CostConversionRate>>();
  const unconverted: string[] = [];

  for (const currency of present) {
    if (currency === displayCurrency) continue; // rule 2: passed through
    const applied = resolveRatesFor(groups, currency, table);
    if (applied) convertible.set(currency, applied);
    else unconverted.push(currency);
  }

  const converted: CostConvertedCurrency[] = [...convertible.entries()].map(
    ([currency, applied]) => ({
      currency,
      // Newest effective date first — the same order the rate editor shows.
      rates: [...applied.values()].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1)),
    }),
  );

  const conversion: CostConversion = { displayCurrency, converted, unconverted };

  if (convertible.size === 0) {
    // Nothing to multiply, but the caller still has to be told which currencies
    // could not be converted — that is the whole point of reporting it.
    return { groups, conversion };
  }

  const out = groups.map((group) => {
    const applied = convertible.get(group.currency);
    if (!applied) return group;
    const rateList = table.get(group.currency) ?? [];
    const convertPoints = (points: Array<{ bucket: string; amount: number }>) =>
      points.map((point) => {
        // `applied` was built from these same points, so a rate exists.
        const rate = rateForDay(rateList, point.bucket)!;
        return { ...point, amount: roundAmount(point.amount * parseRate(rate.rate)!) };
      });
    return {
      ...group,
      currency: displayCurrency,
      points: convertPoints(group.points),
      // Same rates, same days — see `ConvertibleGroup.rawPoints`.
      ...(group.rawPoints ? { rawPoints: convertPoints(group.rawPoints) } : {}),
    };
  });

  return { groups: out, conversion };
}

/**
 * Every rate a currency's points would use, keyed by `effectiveFrom`, or null
 * when any point has no rate at all (rule 4's all-or-nothing).
 */
function resolveRatesFor(
  groups: readonly ConvertibleGroup[],
  currency: string,
  table: ExchangeRateTable,
): Map<string, CostConversionRate> | null {
  const rates = table.get(currency);
  if (!rates || rates.length === 0) return null;

  const applied = new Map<string, CostConversionRate>();
  for (const group of groups) {
    if (group.currency !== currency) continue;
    for (const point of group.points) {
      const match = rateForDay(rates, point.bucket);
      if (!match) return null;
      const value = parseRate(match.rate);
      if (value === null) return null;
      applied.set(match.effectiveFrom, { effectiveFrom: match.effectiveFrom, rate: value });
    }
  }
  // A currency present only through empty-point groups converts trivially; use
  // its latest rate so the caveat can still name one.
  if (applied.size === 0) {
    const latest = rates[0]!;
    const value = parseRate(latest.rate);
    if (value === null) return null;
    applied.set(latest.effectiveFrom, { effectiveFrom: latest.effectiveFrom, rate: value });
  }
  return applied;
}

/**
 * Fold groups that became the same (key, currency) after conversion into one.
 *
 * Conversion turns "AWS in EUR" and "AWS in USD" into two groups with the same
 * key and the same currency, which a chart would draw as two lines called AWS.
 * Points are summed per bucket and re-sorted.
 */
export function mergeConvertedGroups<T extends ConvertibleGroup & { key: string }>(
  groups: T[],
): T[] {
  const byKey = new Map<string, T>();
  const order: string[] = [];
  const mergePoints = (
    into: Array<{ bucket: string; amount: number }>,
    from: Array<{ bucket: string; amount: number }>,
  ) => {
    const buckets = new Map(into.map((p) => [p.bucket, p.amount]));
    for (const point of from) {
      buckets.set(point.bucket, roundAmount((buckets.get(point.bucket) ?? 0) + point.amount));
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([bucket, amount]) => ({ bucket, amount }));
  };
  for (const group of groups) {
    const id = `${group.key} ${group.currency}`;
    const existing = byKey.get(id);
    if (!existing) {
      byKey.set(id, {
        ...group,
        points: [...group.points],
        ...(group.rawPoints ? { rawPoints: [...group.rawPoints] } : {}),
      });
      order.push(id);
      continue;
    }
    existing.points = mergePoints(existing.points, group.points);
    // Merged the same way, or the collected total stops being the sum of the
    // collected series the moment two currencies fold into one.
    if (group.rawPoints) {
      existing.rawPoints = mergePoints(existing.rawPoints ?? [], group.rawPoints);
    }
  }
  return order.map((id) => byKey.get(id)!);
}

/**
 * Convert a `Record<currency, amount>` total map.
 *
 * Used where there are no per-day points to convert against — a showback
 * report's per-centre totals, a budget's month figure — so the rate is picked
 * once, for `day`. Unconvertible currencies keep their own entry.
 */
export function convertTotals(
  totals: Record<string, number>,
  displayCurrency: string | null,
  rates: ExchangeRate[],
  day: string,
): { totals: Record<string, number>; conversion: CostConversion | null } {
  if (!displayCurrency) return { totals, conversion: null };

  const table = buildExchangeRateTable(rates, displayCurrency);
  const out: Record<string, number> = {};
  const converted: CostConvertedCurrency[] = [];
  const unconverted: string[] = [];

  for (const currency of Object.keys(totals).sort()) {
    const amount = totals[currency]!;
    if (currency === displayCurrency) {
      out[currency] = roundAmount((out[currency] ?? 0) + amount);
      continue;
    }
    const match = rateForDay(table.get(currency) ?? [], day);
    const value = match ? parseRate(match.rate) : null;
    if (match && value !== null) {
      out[displayCurrency] = roundAmount((out[displayCurrency] ?? 0) + amount * value);
      converted.push({
        currency,
        rates: [{ effectiveFrom: match.effectiveFrom, rate: value }],
      });
    } else {
      out[currency] = roundAmount((out[currency] ?? 0) + amount);
      unconverted.push(currency);
    }
  }

  return { totals: out, conversion: { displayCurrency, converted, unconverted } };
}
