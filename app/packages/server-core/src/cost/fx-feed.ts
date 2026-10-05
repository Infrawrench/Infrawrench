/**
 * The automatic exchange-rate feed: **pure**. Parsing the publisher's format,
 * holding the history in memory, and answering "what was the rate on this
 * day". No db, no network, no clock, so the holiday and cross-rate rules are
 * exhaustively testable.
 *
 * ## Source
 *
 * The European Central Bank's euro foreign exchange reference rates
 * (https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html).
 * Free, unauthenticated, published around 16:00 CET on every TARGET working
 * day, history back to 1999, about thirty currencies quoted as "units per
 * 1 EUR". The ECB says the rates are for information purposes; that is
 * exactly the use here (presenting spend in one currency), and the source and
 * date of every applied rate are reported beside the converted figure.
 *
 * ## The two rules this module owns
 *
 *  1. **Carry the last publication forward over days with no publication.**
 *     Weekends and TARGET holidays have no rates; the rate for such a day is
 *     the most recent publication on or before it. Carrying is per
 *     *publication*, not per currency: if the ECB published on a later day
 *     without a currency (it suspended ISK from 2008 and stopped RUB in 2022),
 *     that currency has no rate from then on rather than an ever-older one.
 *     Days after the newest publication (today before 16:00 CET, or a future
 *     month-end) carry the newest one.
 *  2. **Cross through EUR.** Every rate is per EUR, so `from -> to` is
 *     `perEur(to) / perEur(from)`, with EUR itself fixed at 1. Both sides come
 *     from the same publication, so the cross is internally consistent.
 */

/** Feed identifier as stored in `fx_reference_rates.source`. */
export const ECB_SOURCE = "ecb" as const;
export const ECB_SOURCE_NAME = "European Central Bank euro foreign exchange reference rates";
export const ECB_SOURCE_URL =
  "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html";
/** Full history since 1999 (~8 MB of XML): fetched once, to backfill. */
export const ECB_HISTORY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml";
/**
 * The trailing 90 days: fetched every day after the backfill. Ninety rather
 * than the single-day file so a poller that was down for a week (or an ECB
 * correction to a recent day) heals on the next run without a re-backfill.
 */
export const ECB_RECENT_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";

/** One publication: a day and its per-EUR rates, as the decimal strings published. */
export interface FxPublication {
  date: string;
  rates: Record<string, string>;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z]{3}$/;

/**
 * Parse an ECB eurofxref XML document (daily, 90-day or full history) into
 * publications, oldest first.
 *
 * A deliberately small scanner rather than an XML library: the format is a
 * flat `<Cube time="..."><Cube currency=".." rate=".."/>...</Cube>` nesting
 * that has not changed since 1999, the server takes no new runtime
 * dependencies for it, and the daily file uses single quotes while the
 * history files use double quotes, which a regex handles and a hand-rolled
 * tokenizer would have to special-case anyway.
 *
 * Throws when the document contains no publications at all: an HTML error
 * page served with a 200 must fail the fetch, not store nothing and look
 * healthy.
 */
export function parseEcbXml(xml: string): FxPublication[] {
  const out: FxPublication[] = [];
  const dayRe = /<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']\s*>([\s\S]*?)<\/Cube>/g;
  const rateRe = /<Cube\s+currency=["']([A-Z]{3})["']\s+rate=["']([0-9.]+)["']\s*\/>/g;
  for (const day of xml.matchAll(dayRe)) {
    const date = day[1]!;
    const rates: Record<string, string> = {};
    for (const r of day[2]!.matchAll(rateRe)) {
      const value = Number(r[2]);
      if (Number.isFinite(value) && value > 0) rates[r[1]!] = r[2]!;
    }
    if (Object.keys(rates).length > 0) out.push({ date, rates });
  }
  if (out.length === 0) {
    throw new Error("ECB response contained no reference-rate publications");
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * The whole feed history, laid out for lookup: one sorted array of
 * publication dates and, per currency, a parallel array of per-EUR values
 * (`NaN` where that publication did not quote the currency).
 *
 * Compact on purpose. The full ECB history is ~7,000 publications by ~30
 * currencies; as parallel `Float64Array`s that is under 2 MB, small enough to
 * hold per process and look up synchronously from the pure converter, which
 * is what lets every cost surface use the feed without threading a date range
 * through its loader.
 */
export interface FxFeedSnapshot {
  source: typeof ECB_SOURCE;
  dates: string[];
  perEur: Map<string, Float64Array>;
}

/** Build a snapshot from publications (any order; duplicates keep the last). */
export function buildFxFeedSnapshot(publications: readonly FxPublication[]): FxFeedSnapshot {
  const byDate = new Map<string, Record<string, string>>();
  for (const p of publications) {
    if (!ISO_DAY.test(p.date)) continue;
    byDate.set(p.date, { ...(byDate.get(p.date) ?? {}), ...p.rates });
  }
  const dates = [...byDate.keys()].sort();
  const perEur = new Map<string, Float64Array>();
  dates.forEach((date, i) => {
    for (const [currency, raw] of Object.entries(byDate.get(date)!)) {
      if (!CODE.test(currency) || currency === "EUR") continue;
      let column = perEur.get(currency);
      if (!column) {
        column = new Float64Array(dates.length).fill(Number.NaN);
        perEur.set(currency, column);
      }
      const value = Number(raw);
      column[i] = Number.isFinite(value) && value > 0 ? value : Number.NaN;
    }
  });
  return { source: ECB_SOURCE, dates, perEur };
}

/** Index of the newest publication on or before `day`, or -1. Binary search. */
export function publicationIndexFor(snapshot: FxFeedSnapshot, day: string): number {
  const { dates } = snapshot;
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! <= day) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** A feed rate for a pair on a day, and the publication it came from. */
export interface FeedRate {
  rate: number;
  /** Publication date used: `day` itself, or the last one before it. */
  rateDate: string;
}

/**
 * Units of `to` per unit of `from` on `day`, from the newest publication on or
 * before it, crossed through EUR. Null when there is no publication that early
 * or that publication does not quote one of the two currencies.
 */
export function feedRateFor(
  snapshot: FxFeedSnapshot | null,
  from: string,
  to: string,
  day: string,
): FeedRate | null {
  if (!snapshot || from === to) return null;
  const index = publicationIndexFor(snapshot, day);
  if (index < 0) return null;
  const perEur = (currency: string): number => {
    if (currency === "EUR") return 1;
    const column = snapshot.perEur.get(currency);
    return column ? column[index]! : Number.NaN;
  };
  const fromPerEur = perEur(from);
  const toPerEur = perEur(to);
  if (!Number.isFinite(fromPerEur) || !Number.isFinite(toPerEur)) return null;
  // Ten significant figures: the published rates carry four to six, so this
  // keeps every digit of a direct EUR quote and loses nothing meaningful from
  // a cross, while keeping `1.1225 / 0.85033`'s float tail out of the JSON.
  const rate = Number((toPerEur / fromPerEur).toPrecision(10));
  return { rate, rateDate: snapshot.dates[index]! };
}

/** Currencies quoted in the newest publication, plus EUR, sorted. */
export function feedCurrencies(snapshot: FxFeedSnapshot | null): string[] {
  if (!snapshot || snapshot.dates.length === 0) return [];
  const last = snapshot.dates.length - 1;
  const codes = [...snapshot.perEur.entries()]
    .filter(([, column]) => Number.isFinite(column[last]!))
    .map(([code]) => code);
  return [...codes, "EUR"].sort();
}

/** Last calendar day of the month `day` falls in, as `YYYY-MM-DD`. */
export function monthEndOf(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  // Day 0 of the next month is the last day of this one; UTC so no timezone
  // can move it.
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${day.slice(0, 7)}-${String(last).padStart(2, "0")}`;
}

/** Re-check delay on a working day whose publication is not out yet. */
const LATE_RECHECK_MS = 2 * 60 * 60 * 1000;
/** Minutes past midnight UTC we first look for the day's publication. */
const DAILY_FETCH_UTC_MINUTES = 15 * 60 + 30;

/**
 * When to fetch next, after a successful fetch at `now` whose newest
 * publication is `latestRateDate`.
 *
 * The ECB publishes around 16:00 CET (14:00 or 15:00 UTC) on working days. So
 * the next fetch is 15:30 UTC: today's if that is still ahead, otherwise
 * tomorrow's. On a weekday after 15:30 UTC whose publication is not stored yet
 * (running late, or a TARGET holiday the code does not need to know about),
 * look again in two hours until 22:00 UTC, then give up until tomorrow.
 * Pure, for tests; the pass in `./fx-feed-pass.ts` calls it.
 */
export function nextFxFetchAt(now: Date, latestRateDate: string | null): Date {
  const today = now.toISOString().slice(0, 10);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const weekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5;
  const todayTarget = new Date(`${today}T15:30:00.000Z`);
  if (minutes < DAILY_FETCH_UTC_MINUTES) return todayTarget;
  if (weekday && (latestRateDate ?? "") < today && now.getUTCHours() < 22) {
    return new Date(now.getTime() + LATE_RECHECK_MS);
  }
  return new Date(todayTarget.getTime() + 24 * 60 * 60 * 1000);
}
