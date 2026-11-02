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

/** A lease's length in months: `1yr` is 12, `10yr` (Azure reservations) 120, `3mo` (RunPod savings plans, Alibaba subscriptions) 3; null if unknown. */
export function leaseMonths(lease: string): number | null {
  const match = /^(\d+)(yr|mo)$/.exec(lease);
  if (!match) return null;
  return Number(match[1]) * (match[2] === "yr" ? 12 : 1);
}

/** What a reservation costs per hour over its lease, counting the upfront payment. */
export function effectiveHourly(term: ReservedTerm, hourly: number, upfront: number): number {
  const months = leaseMonths(term.lease);
  return months ? hourly + upfront / (months * DURATIONS.monthly.hours) : hourly;
}

const PURCHASE_OPTIONS: Readonly<Record<string, string>> = {
  "No Upfront": msg("No Upfront"),
  "Partial Upfront": msg("Partial Upfront"),
  "All Upfront": msg("All Upfront"),
};

/**
 * "No Upfront", or "No Upfront (Convertible)", in the reader's language. The
 * other clouds' commitments are named for what they are: RunPod's and
 * Azure's savings plans, Alibaba's subscriptions and Google Cloud's committed
 * use discounts each have one payment option, so it would add nothing;
 * Alibaba's and Azure's reserved instances say which they are, since the same
 * instance also has subscriptions or savings plans.
 */
export function termLabel(term: ReservedTerm, tr: Translate): string {
  const option = tr(PURCHASE_OPTIONS[term.purchaseOption] ?? term.purchaseOption);
  switch (term.offeringClass) {
    case "convertible":
      return tr(msg("{option} (Convertible)"), { option });
    case "Savings Plan":
      return tr(msg("Savings plan"));
    case "Subscription":
      return tr(msg("Subscription"));
    case "Committed Use":
      return tr(msg("Committed use discount"));
    case "Reserved Instance":
      return tr(msg("Reserved instance, {option}"), { option });
    default:
      return option;
  }
}

/** "1 year", "3 years", "6 months". */
export function leaseLabel(lease: string, tr: Translate): string {
  const match = /^(\d+)(yr|mo)$/.exec(lease);
  if (!match) return lease;
  const count = Number(match[1]);
  return match[2] === "yr"
    ? tr(msg("{count, plural, one {# year} other {# years}}"), { count })
    : tr(msg("{count, plural, one {# month} other {# months}}"), { count });
}

/**
 * What a committed price is called beside the on-demand one: "1-year
 * reserved", "3-month savings plan", "1-year subscription", "1-year
 * commitment".
 */
export function commitmentLabel(term: ReservedTerm, tr: Translate): string {
  const lease = leaseLabel(term.lease, tr);
  switch (term.offeringClass) {
    case "Savings Plan":
      return tr(msg("Savings plan, {lease}"), { lease });
    case "Subscription":
      return tr(msg("Subscription, {lease}"), { lease });
    case "Committed Use":
      if (term.lease === "1yr") return tr(msg("1-year commitment"));
      if (term.lease === "3yr") return tr(msg("3-year commitment"));
      return tr(msg("Commitment, {lease}"), { lease });
    default:
      if (term.lease === "1yr") return tr(msg("1-year reserved"));
      if (term.lease === "3yr") return tr(msg("3-year reserved"));
      return tr(msg("Reserved, {lease}"), { lease });
  }
}

/** Term options that combine with a lease: everything but the lease length. */
export function termOptionKey(term: ReservedTerm): string {
  return `${term.offeringClass}|${term.purchaseOption}`;
}
