/**
 * Org exchange rates — the shared contract for the opt-in display currency and
 * the rate table an org states itself.
 *
 * The premise of the whole feature is in one sentence: **the rates are the
 * org's, not ours.** Infrawrench never fetches live FX. A finance team
 * reconciles a converted total against the rate their accounting system booked
 * the month at, which is a decision someone made — not today's mid-market
 * quote, and not a number a monitoring tool should invent on their behalf. So
 * the org states a rate, with the date it started applying, and a historical
 * period converts at the rate that applied then.
 *
 * Two consequences shape every type below:
 *
 *  - **Opt in, never automatic.** `displayCurrency: null` (the state of every
 *    org that has never opened the form) means "do not convert", and every
 *    surface then behaves exactly as it did before this file existed.
 *  - **A missing rate is visible, not silent.** Nothing here lets a currency
 *    disappear because the org forgot to price it. Conversion reports what it
 *    could not convert (`CostConversion.unconverted` in `./costs`) and the
 *    amount survives in its own currency.
 *
 * Rates are stated to the display currency in one hop. We deliberately do not
 * invert (`EUR→USD` implying `USD→EUR`) or triangulate (`GBP→EUR` plus
 * `EUR→USD` implying `GBP→USD`): both would produce a number the org never
 * stated and cannot reconcile, which is the one thing this feature exists to
 * avoid.
 */

/** ISO 4217-shaped code: three ASCII letters, upper-cased on the way in. */
export const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** Bounds the API enforces on the rate table. */
export const EXCHANGE_RATE_LIMITS = {
  /**
   * Decimal places kept. Matches the `numeric(20, 10)` column: enough for the
   * low-value currencies (a VND→USD rate is ~0.0000395, still six significant
   * figures here) without inviting a rate typed to fifteen places that no
   * accounting system ever produced.
   */
  rateScale: 10,
  /**
   * A rate must be strictly positive. Zero would silently erase a currency's
   * spend from the total — the exact failure this feature is built to prevent —
   * and a negative rate has no meaning.
   */
  rateMin: 1e-10,
  /**
   * Loose upper bound. Real rates reach ~1e5 (IDR per USD is ~16,000), so this
   * only catches a pasted amount where a rate belongs.
   */
  rateMax: 1e9,
  /** Rate rows per org. Well past a decade of monthly rates for ten currencies. */
  maxRates: 2000,
} as const;

/**
 * The org's display currency, or `null` for "do not convert".
 *
 * Null is not a missing value — it is the configured, default, honest state.
 * An org with no row and an org that explicitly cleared the setting are the
 * same org, and both get unconverted per-currency numbers.
 */
export interface OrgCurrencySettings {
  displayCurrency: string | null;
}

/** One stated rate, as the API returns it. */
export interface ExchangeRate {
  id: string;
  /** Currency being converted *from*, e.g. `"EUR"`. */
  fromCurrency: string;
  /**
   * Currency being converted *to*. Stored per row rather than derived from
   * `OrgCurrencySettings.displayCurrency` so that changing the display currency
   * does not silently re-interpret every historical rate as pointing somewhere
   * it never pointed.
   */
  toCurrency: string;
  /**
   * Multiply an amount in `fromCurrency` by this to get `toCurrency`.
   *
   * A **string**, not a number, all the way to the edge of the UI: it is a
   * decimal the org typed and must round-trip to the character. See the
   * `org_exchange_rates.rate` column JSDoc for why the storage is `numeric`.
   */
  rate: string;
  /**
   * Inclusive `YYYY-MM-DD` from which this rate applies. Lookup for a given day
   * picks the latest row whose `effectiveFrom <= day`; a day earlier than every
   * stated rate has no rate and converts nothing.
   */
  effectiveFrom: string;
  /** User id that stated the rate — this is a finance-governance record. */
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body of a rate create/update. */
export interface ExchangeRateInput {
  fromCurrency: string;
  toCurrency: string;
  rate: string;
  effectiveFrom: string;
}

/** `GET /costs/currency` — the settings plus the whole rate table. */
export interface OrgCurrencyConfig extends OrgCurrencySettings {
  rates: ExchangeRate[];
}

/**
 * Normalize a currency code the way the API does, so a form can show the same
 * value it will get back. Returns null when the input is not code-shaped.
 */
export function normalizeCurrencyCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return CURRENCY_CODE_PATTERN.test(code) ? code : null;
}

/**
 * One-line description of a conversion, for places too small for the full
 * notice — a graph card's footnote, a mobile summary line, a chart's aria
 * label. Returns null when nothing was converted.
 *
 * Shared so every compact surface says the same two things in the same order:
 * what was folded in and at whose rates, then what is still sitting outside the
 * headline number.
 */
export function describeCostConversion(
  conversion:
    | { displayCurrency: string; converted: Array<{ currency: string }>; unconverted: string[] }
    | undefined,
): string | null {
  if (!conversion) return null;
  const parts: string[] = [];
  if (conversion.converted.length > 0) {
    parts.push(
      `${conversion.converted.map((c) => c.currency).join(", ")} converted to ${conversion.displayCurrency} at your organization's stated rates`,
    );
  }
  if (conversion.unconverted.length > 0) {
    parts.push(
      `${conversion.unconverted.join(", ")} shown separately — no exchange rate configured`,
    );
  }
  return parts.length > 0 ? `${parts.join("; ")}.` : null;
}

/**
 * The rate table an org holds, keyed for lookup. Built once per query and
 * handed to the pure converter.
 *
 * Rows are grouped by `fromCurrency` and each list is sorted by
 * `effectiveFrom` **descending**, which makes "the latest rate on or before
 * this day" the first match in a linear scan.
 */
export type ExchangeRateTable = Map<string, ExchangeRate[]>;

/**
 * Group and sort rates for lookup. Rows whose `toCurrency` is not the display
 * currency are dropped here rather than being quietly used: a rate to some
 * other currency is not evidence about this one.
 */
export function buildExchangeRateTable(
  rates: ExchangeRate[],
  displayCurrency: string,
): ExchangeRateTable {
  const table: ExchangeRateTable = new Map();
  for (const rate of rates) {
    if (rate.toCurrency !== displayCurrency) continue;
    // Spend already in the display currency is passed through untouched, so a
    // self-rate is meaningless at best and a way to scale a total at worst.
    if (rate.fromCurrency === displayCurrency) continue;
    const list = table.get(rate.fromCurrency) ?? [];
    list.push(rate);
    table.set(rate.fromCurrency, list);
  }
  for (const list of table.values()) {
    list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  }
  return table;
}
