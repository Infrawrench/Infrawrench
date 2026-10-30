import { msg } from "gt-react";
import type { ReservedTerm } from "./decode";
import type { Translate } from "./i18n/server";

/** Labels are `msg()` sources: translate them with `useDataString()` or a server `Translate`. */
export const DURATIONS = {
  hourly: { label: msg("Hourly"), hours: 1 },
  daily: { label: msg("Daily"), hours: 24 },
  weekly: { label: msg("Weekly"), hours: 24 * 7 },
  monthly: { label: msg("Monthly"), hours: (365 * 24) / 12 },
  annually: { label: msg("Annually"), hours: 365 * 24 },
} as const;

export type Duration = keyof typeof DURATIONS;

export function isDuration(value: string | null): value is Duration {
  return value !== null && Object.hasOwn(DURATIONS, value);
}

/** The currency prices are shown in, and how many of it one USD buys. */
export interface Money {
  code: string;
  rate: number;
}

export const USD: Money = { code: "USD", rate: 1 };

/**
 * A USD amount in `money`, written the way `locale` writes money, with more
 * decimals for small amounts so sub-cent hourly prices stay readable.
 */
export function formatMoney(usd: number, money: Money = USD, locale = "en"): string {
  const value = usd * money.rate;
  const digits = value !== 0 && Math.abs(value) < 1 ? 4 : Math.abs(value) < 100 ? 3 : 2;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: money.code,
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(value);
}

/** The price over `duration`, or `null` when there is none; callers say "N/A" in their language. */
export function formatPrice(
  hourly: number | null | undefined,
  duration: Duration,
  money: Money = USD,
  locale = "en",
): string | null {
  if (hourly === null || hourly === undefined) return null;
  return formatMoney(hourly * DURATIONS[duration].hours, money, locale);
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

export function formatDate(unixSeconds: number, locale = "en"): string {
  let format = dateFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    dateFormats.set(locale, format);
  }
  return format.format(new Date(unixSeconds * 1000));
}

const LEASE_HOURS: Readonly<Record<string, number>> = { "1yr": 365 * 24, "3yr": 3 * 365 * 24 };

/** What a reservation costs per hour over its lease, counting the upfront payment. */
export function effectiveHourly(term: ReservedTerm, hourly: number, upfront: number): number {
  const hours = LEASE_HOURS[term.lease];
  return hours ? hourly + upfront / hours : hourly;
}

const PURCHASE_OPTIONS: Readonly<Record<string, string>> = {
  "No Upfront": msg("No Upfront"),
  "Partial Upfront": msg("Partial Upfront"),
  "All Upfront": msg("All Upfront"),
};

/** "No Upfront", or "No Upfront (Convertible)", in the reader's language. */
export function termLabel(term: ReservedTerm, tr: Translate): string {
  const option = tr(PURCHASE_OPTIONS[term.purchaseOption] ?? term.purchaseOption);
  return term.offeringClass === "convertible"
    ? tr(msg("{option} (Convertible)"), { option })
    : option;
}

/** "1 year", "3 years". */
export function leaseLabel(lease: string, tr: Translate): string {
  const years = /^(\d+)yr$/.exec(lease)?.[1];
  return years
    ? tr(msg("{count, plural, one {# year} other {# years}}"), { count: Number(years) })
    : lease;
}

/** Term options that combine with a lease: everything but the lease length. */
export function termOptionKey(term: ReservedTerm): string {
  return `${term.offeringClass}|${term.purchaseOption}`;
}
