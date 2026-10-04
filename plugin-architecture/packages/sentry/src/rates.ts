/**
 * Prices used to turn Sentry usage into money.
 *
 * Sentry's public API meters usage (`stats_v2`) but exposes no subscription,
 * on-demand budget, spend or invoice data: those live in the closed-source
 * billing layer behind undocumented endpoints. So every amount this plugin
 * writes is usage beyond an included amount multiplied by a rate, and the
 * rates are credential fields the user can overwrite with their plan's
 * numbers (Edit credentials) at any time.
 *
 * Defaults are the Team plan's published pay-as-you-go prices at the lowest
 * tier, and the volumes every plan includes (https://docs.sentry.io/pricing/
 * and https://sentry.io/pricing/, checked 2026-10):
 * - Errors: 50k included, $0.0003625 each (Business: $0.0011125).
 * - Spans: 5M included, $0.0000020 each (Business: $0.0000040).
 * - Replays: 50 included, $0.00375 each.
 * - Attachments: 1 GB included, $0.3125/GB.
 * - Logs: 5 GB included, $0.50/GB.
 * - Continuous profiling $0.0315/hour, UI profiling $0.25/hour.
 * - Cron monitors $0.78 and uptime monitors $1.00 each a month, one of each
 *   included.
 * - Team plan fee $26/month (annual billing; Business is $80).
 * - Transactions (the pre-span performance unit on older plans) have no
 *   current list price, so they are only priced once a rate is entered.
 */

export interface CategoryRate {
  /** USD per unit (event, GB or hour). Undefined: not priced. */
  price?: number;
  /** Units included in the plan each month before the price applies. */
  included: number;
}

export interface SentryRates {
  planFee: number;
  errors: CategoryRate;
  spans: CategoryRate;
  transactions: CategoryRate;
  replays: CategoryRate;
  attachments: CategoryRate;
  logs: CategoryRate;
  continuousProfiling: CategoryRate;
  uiProfiling: CategoryRate;
  cronMonitors: CategoryRate;
  uptimeMonitors: CategoryRate;
}

export type RatedCategory = Exclude<keyof SentryRates, "planFee">;

/** Credential keys, so plugin.ts and the parser cannot drift. */
export const RATE_KEYS = {
  planFee: "planFee",
  errorPrice: "errorPrice",
  errorsIncluded: "errorsIncluded",
  spanPrice: "spanPrice",
  spansIncluded: "spansIncluded",
  transactionPrice: "transactionPrice",
  replayPrice: "replayPrice",
  replaysIncluded: "replaysIncluded",
  attachmentPricePerGb: "attachmentPricePerGb",
  attachmentGbIncluded: "attachmentGbIncluded",
  logPricePerGb: "logPricePerGb",
  logGbIncluded: "logGbIncluded",
  continuousProfilingPricePerHour: "continuousProfilingPricePerHour",
  uiProfilingPricePerHour: "uiProfilingPricePerHour",
  cronMonitorPrice: "cronMonitorPrice",
  cronMonitorsIncluded: "cronMonitorsIncluded",
  uptimeMonitorPrice: "uptimeMonitorPrice",
  uptimeMonitorsIncluded: "uptimeMonitorsIncluded",
} as const;

export const DEFAULT_RATES: Partial<Record<keyof typeof RATE_KEYS, string>> = {
  planFee: "26",
  errorPrice: "0.0003625",
  errorsIncluded: "50000",
  spanPrice: "0.000002",
  spansIncluded: "5000000",
  replayPrice: "0.00375",
  replaysIncluded: "50",
  attachmentPricePerGb: "0.3125",
  attachmentGbIncluded: "1",
  logPricePerGb: "0.50",
  logGbIncluded: "5",
  continuousProfilingPricePerHour: "0.0315",
  uiProfilingPricePerHour: "0.25",
  cronMonitorPrice: "0.78",
  cronMonitorsIncluded: "1",
  uptimeMonitorPrice: "1.00",
  uptimeMonitorsIncluded: "1",
};

function parseRate(
  credentials: Record<string, string>,
  key: keyof typeof RATE_KEYS,
  label: string,
): number | undefined {
  const raw = (credentials[RATE_KEYS[key]] ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  const value = raw === "" ? DEFAULT_RATES[key] : raw;
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Sentry plugin: "${label}" must be a non-negative number, got "${raw}".`);
  }
  return n;
}

function rate(price: number | undefined, included: number | undefined): CategoryRate {
  return { ...(price !== undefined ? { price } : {}), included: included ?? 0 };
}

export function parseRates(credentials: Record<string, string>): SentryRates {
  const p = (key: keyof typeof RATE_KEYS, label: string) => parseRate(credentials, key, label);
  return {
    planFee: p("planFee", "Plan fee") ?? 0,
    errors: rate(p("errorPrice", "Price per error"), p("errorsIncluded", "Errors included")),
    spans: rate(p("spanPrice", "Price per span"), p("spansIncluded", "Spans included")),
    transactions: rate(p("transactionPrice", "Price per transaction"), 0),
    replays: rate(p("replayPrice", "Price per replay"), p("replaysIncluded", "Replays included")),
    attachments: rate(
      p("attachmentPricePerGb", "Attachment price per GB"),
      p("attachmentGbIncluded", "Attachment GB included"),
    ),
    logs: rate(p("logPricePerGb", "Log price per GB"), p("logGbIncluded", "Log GB included")),
    continuousProfiling: rate(
      p("continuousProfilingPricePerHour", "Continuous profiling price per hour"),
      0,
    ),
    uiProfiling: rate(p("uiProfilingPricePerHour", "UI profiling price per hour"), 0),
    cronMonitors: rate(
      p("cronMonitorPrice", "Price per cron monitor"),
      p("cronMonitorsIncluded", "Cron monitors included"),
    ),
    uptimeMonitors: rate(
      p("uptimeMonitorPrice", "Price per uptime monitor"),
      p("uptimeMonitorsIncluded", "Uptime monitors included"),
    ),
  };
}

/**
 * Usage categories priced from `stats_v2`, keyed by the category names Sentry
 * reports. `divisor` converts the reported quantity to the priced unit:
 * attachments and logs are reported in bytes, profiling in milliseconds.
 * `service` is the stable cost-row service name (it keys stored rows).
 */
export interface UsageCategory {
  key: RatedCategory;
  service: string;
  /** stats_v2 category names that roll up into this one. */
  sentryCategories: string[];
  divisor: number;
  unit: string;
}

const GB = 1_000_000_000;
const HOUR_MS = 3_600_000;

export const USAGE_CATEGORIES: UsageCategory[] = [
  {
    key: "errors",
    service: "Errors",
    sentryCategories: ["error", "default", "security"],
    divisor: 1,
    unit: "Events",
  },
  { key: "spans", service: "Spans", sentryCategories: ["span"], divisor: 1, unit: "Spans" },
  {
    key: "transactions",
    service: "Transactions",
    sentryCategories: ["transaction"],
    divisor: 1,
    unit: "Transactions",
  },
  { key: "replays", service: "Replays", sentryCategories: ["replay"], divisor: 1, unit: "Replays" },
  {
    key: "attachments",
    service: "Attachments",
    sentryCategories: ["attachment"],
    divisor: GB,
    unit: "GB",
  },
  { key: "logs", service: "Logs", sentryCategories: ["log_byte"], divisor: GB, unit: "GB" },
  {
    key: "continuousProfiling",
    service: "Continuous profiling",
    sentryCategories: ["profile_duration"],
    divisor: HOUR_MS,
    unit: "Hours",
  },
  {
    key: "uiProfiling",
    service: "UI profiling",
    sentryCategories: ["profile_duration_ui"],
    divisor: HOUR_MS,
    unit: "Hours",
  },
];

/** Category for a stats_v2 category name, if it is one this plugin prices. */
export function usageCategoryOf(sentryCategory: string): UsageCategory | undefined {
  return USAGE_CATEGORIES.find((c) => c.sentryCategories.includes(sentryCategory));
}

export const SERVICES = {
  plan: "Plan",
  cronMonitors: "Cron monitors",
  uptimeMonitors: "Uptime monitors",
} as const;
