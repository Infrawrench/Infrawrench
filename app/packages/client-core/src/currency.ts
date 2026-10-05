/**
 * Org exchange rates: the shared contract for the opt-in display currency, the
 * rate table an org states itself, and the optional automatic daily feed.
 *
 * The premise of the feature: **the org decides which rates apply.** A finance
 * team reconciles a converted total against the rate their accounting system
 * booked, so nothing converts until the org opts in, and every converted figure
 * says which rate produced it. There are two ways to supply rates:
 *
 *  - **Stated rates** (`org_exchange_rates`): typed by someone on the team, with
 *    the date they start applying and optionally the date they stop. Always
 *    one hop to a named currency; never inverted or chained.
 *  - **Automatic rates** (opt-in, `autoRates`): the European Central Bank's
 *    euro foreign exchange reference rates, fetched daily by the poller and
 *    stored once for every org. Weekends and TARGET holidays carry the last
 *    published rate forward; a pair where neither side is EUR is crossed
 *    through EUR (`GBP->USD = USD per EUR / GBP per EUR`), the only arithmetic
 *    the ECB publication supports. Currencies the ECB does not publish are
 *    **manual-only**: they convert when the org states a rate and are reported
 *    unconverted otherwise.
 *
 * Precedence is fixed and documented: a stated rate in force on a day always
 * wins over the feed for its currency, so an org can let the feed run and pin
 * the months its books closed at a different number. When a stated rate has an
 * `effectiveTo`, the feed takes over again the day after.
 *
 * Two consequences shape every type below:
 *
 *  - **Opt in, never automatic.** `displayCurrency: null` (the state of every
 *    org that has never opened the form) means "do not convert", and every
 *    surface then behaves exactly as it did before this file existed.
 *  - **A missing rate is visible, not silent.** Nothing here lets a currency
 *    disappear because no rate covered it. Conversion reports what it could
 *    not convert (`CostConversion.unconverted` in `./costs`) and the amount
 *    survives in its own currency.
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
   * spend from the total (the exact failure this feature is built to prevent)
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
 * Null is not a missing value: it is the configured, default, honest state.
 * An org with no row and an org that explicitly cleared the setting are the
 * same org, and both get unconverted per-currency numbers.
 */
export interface OrgCurrencySettings {
  displayCurrency: string | null;
  /**
   * Fill gaps from the automatic daily reference-rate feed. Off by default:
   * an org that has only ever stated its own rates keeps converting at exactly
   * those and nothing else. Stated rates still win over the feed when on.
   */
  autoRates: boolean;
  /**
   * Which feed rate converts a day's spend: `daily` uses the rate for that
   * day (carried forward over weekends and holidays), `month_end` uses the
   * rate in force on the last day of that day's month, so a whole month
   * converts at one rate the way most month-end closes book it. Only affects
   * feed rates; a stated rate applies to the days its own dates cover.
   */
  rateBasis: ExchangeRateBasis;
}

/**
 * Body of `PUT /currency`. `autoRates` and `rateBasis` are optional so a
 * client written before the feed existed (which sends only the display
 * currency) leaves them as they were rather than resetting them.
 */
export interface OrgCurrencySettingsInput {
  displayCurrency: string | null;
  autoRates?: boolean | undefined;
  rateBasis?: ExchangeRateBasis | undefined;
}

/** See `OrgCurrencySettings.rateBasis`. */
export const EXCHANGE_RATE_BASES = ["daily", "month_end"] as const;
export type ExchangeRateBasis = (typeof EXCHANGE_RATE_BASES)[number];

/** Where an applied rate came from. `ecb` is the only feed today. */
export const EXCHANGE_RATE_SOURCES = ["manual", "ecb"] as const;
export type ExchangeRateSource = (typeof EXCHANGE_RATE_SOURCES)[number];

/** Human label for a rate source, in English (translated at the UI edge). */
export const EXCHANGE_RATE_SOURCE_LABELS: Record<ExchangeRateSource, string> = {
  manual: "your stated rate",
  ecb: "ECB reference rate",
};

/**
 * State of the automatic rate feed, as `GET /currency` reports it. Global
 * (one feed for every org), so this is the same object for everyone.
 */
export interface FxFeedStatus {
  source: "ecb";
  /** Publisher's own name for the series, for display. */
  sourceName: string;
  /** Where the rates come from, so a reader can check a figure. */
  sourceUrl: string;
  /** Newest publication stored, or null before the first successful fetch. */
  latestRateDate: string | null;
  /** Oldest publication stored (the backfill horizon). */
  earliestRateDate: string | null;
  /**
   * Currencies in the newest publication, plus EUR. A currency outside this
   * list is manual-only: it converts only at a rate the org states.
   */
  currencies: string[];
  /** Last successful fetch (ISO timestamp), or null. */
  lastSuccessAt: string | null;
  /** Error from the most recent failed fetch, cleared on success. */
  lastError: string | null;
}

/**
 * `GET /currency/lookup`: the rate a given day of spend would convert at,
 * after the org's precedence rules. Null `rate` means none applies and the
 * amount would be reported unconverted.
 */
export interface ExchangeRateLookup {
  fromCurrency: string;
  toCurrency: string;
  /** The day of spend asked about. */
  date: string;
  rateBasis: ExchangeRateBasis;
  rate: number | null;
  source: ExchangeRateSource | null;
  /** Publication date of the feed rate, or the stated rate's effective date. */
  rateDate: string | null;
  /** The stated rate row that won, when `source` is `manual`. */
  manualRateId: string | null;
  /** Plain-English account of why this rate (or no rate) applies. */
  explanation: string;
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
  /**
   * Inclusive `YYYY-MM-DD` after which this rate stops applying, or null for
   * open-ended (until a later stated rate supersedes it). A day past the end
   * falls back to the automatic feed when it is on, and is otherwise
   * unconverted: an older stated rate does not resurface, because the end date
   * was someone saying "not this number after this day".
   */
  effectiveTo: string | null;
  /** User id that stated the rate: this is a finance-governance record. */
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
  /** Omitted or null for open-ended. Must not be before `effectiveFrom`. */
  effectiveTo?: string | null | undefined;
}

/** `GET /currency`: the settings, the whole rate table, and the feed state. */
export interface OrgCurrencyConfig extends OrgCurrencySettings {
  rates: ExchangeRate[];
  feed: FxFeedStatus;
}

/**
 * Normalize a currency code the way the API does, so a form can show the same
 * value it will get back. Returns null when the input is not code-shaped.
 */
export function normalizeCurrencyCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return CURRENCY_CODE_PATTERN.test(code) ? code : null;
}

/** A conversion's applied rates, condensed per source for display. */
export interface ConversionRateSummary {
  source: ExchangeRateSource;
  /** Distinct rates applied from this source. */
  count: number;
  /** Earliest and latest rate dates (effective date or publication date). */
  firstRateDate: string;
  lastRateDate: string;
  minRate: number;
  maxRate: number;
}

/** The fields of `CostConversionRate` the helpers below read. */
export interface ConversionRateLike {
  effectiveFrom: string;
  rate: number;
  source?: ExchangeRateSource | undefined;
  firstDay?: string | undefined;
  lastDay?: string | undefined;
}

/**
 * Group a converted currency's applied rates by source. A daily feed applied
 * across a quarter is sixty-odd rates; a summary line names the source, the
 * date span and the range instead of listing each one. Stated rates come
 * first because they are the ones a reader is most likely reconciling.
 */
export function summarizeConversionRates(
  rates: readonly ConversionRateLike[],
): ConversionRateSummary[] {
  const bySource = new Map<ExchangeRateSource, ConversionRateSummary>();
  for (const r of rates) {
    const source = r.source ?? "manual";
    const existing = bySource.get(source);
    if (!existing) {
      bySource.set(source, {
        source,
        count: 1,
        firstRateDate: r.effectiveFrom,
        lastRateDate: r.effectiveFrom,
        minRate: r.rate,
        maxRate: r.rate,
      });
      continue;
    }
    existing.count += 1;
    if (r.effectiveFrom < existing.firstRateDate) existing.firstRateDate = r.effectiveFrom;
    if (r.effectiveFrom > existing.lastRateDate) existing.lastRateDate = r.effectiveFrom;
    existing.minRate = Math.min(existing.minRate, r.rate);
    existing.maxRate = Math.max(existing.maxRate, r.rate);
  }
  return EXCHANGE_RATE_SOURCES.flatMap((s) => {
    const found = bySource.get(s);
    return found ? [found] : [];
  });
}

/**
 * The applied rate behind one day of a converted series, for a tooltip. Uses
 * the `firstDay`/`lastDay` span the server reports per rate, so the client
 * never re-implements precedence. Null when the currency was not converted or
 * the server predates per-rate spans.
 */
export function conversionRateForDay<R extends ConversionRateLike>(
  converted: { currency: string; rates: readonly R[] } | undefined,
  day: string,
): R | null {
  if (!converted) return null;
  for (const r of converted.rates) {
    if (r.firstDay && r.lastDay && r.firstDay <= day && day <= r.lastDay) return r;
  }
  return null;
}

/**
 * One-line "what rate, from where, dated when" for a single applied rate:
 * `1.1225 (ECB reference rate, 2026-10-02)`. Shared by the CLI, digest and
 * export columns so the wording cannot drift between them.
 */
export function describeAppliedRate(rate: ConversionRateLike): string {
  const source = EXCHANGE_RATE_SOURCE_LABELS[rate.source ?? "manual"];
  return `${rate.rate} (${source}, ${rate.effectiveFrom})`;
}

/**
 * One-line description of a conversion, for places too small for the full
 * notice: a graph card's footnote, a mobile summary line, a chart's aria
 * label. Returns null when nothing was converted.
 *
 * Shared so every compact surface says the same things in the same order:
 * what was folded in, at whose rates and dated when, then what is still
 * sitting outside the headline number.
 */
export function describeCostConversion(
  conversion:
    | {
        displayCurrency: string;
        converted: Array<{ currency: string; rates?: readonly ConversionRateLike[] }>;
        unconverted: string[];
      }
    | undefined,
): string | null {
  if (!conversion) return null;
  const parts: string[] = [];
  if (conversion.converted.length > 0) {
    const summaries = summarizeConversionRates(conversion.converted.flatMap((c) => c.rates ?? []));
    const sources = summaries.map((s) => {
      const span =
        s.firstRateDate === s.lastRateDate
          ? s.firstRateDate
          : `${s.firstRateDate} to ${s.lastRateDate}`;
      return s.source === "manual"
        ? `your organization's stated rates (${span})`
        : `ECB reference rates (${span})`;
    });
    parts.push(
      `${conversion.converted.map((c) => c.currency).join(", ")} converted to ${conversion.displayCurrency} at ${
        sources.length > 0 ? sources.join(" and ") : "your organization's stated rates"
      }`,
    );
  }
  if (conversion.unconverted.length > 0) {
    parts.push(
      `${conversion.unconverted.join(", ")} shown separately, no exchange rate covers this range`,
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
