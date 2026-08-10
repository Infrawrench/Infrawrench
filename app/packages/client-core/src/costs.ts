/**
 * The cost contract, shared by every client that renders cost data: the
 * collection status, the widget configuration a dashboard stores, the
 * `/costs/query` request and response, the budget row, and the pure helpers
 * that shape all of it for a chart.
 *
 * It lives here rather than in `@infrawrench/ui` because mobile doesn't depend
 * on that package — `ui/src/cost/config.ts` keeps the zod schemas (the API
 * validates against them) and re-exports these types, so web, desktop, mobile,
 * and the CLI all describe the same bytes.
 *
 * Collection runs daily in the background and backs off on failure, so a
 * misconfigured provider otherwise reads as a permanently empty graph — the
 * status types carry the reason (and the provider page that fixes it) out to
 * every surface.
 */

import type { CostCapabilityDeclaration } from "@infrawrench/plugin-base";

import type { CostReportWidgetConfig } from "./cost-reports";
import type { CloudFetch } from "./fetch";
import type { CustomGraphWidgetConfig } from "./custom-graphs";

/** Why an account's last cost collection failed, as stored by the poller. */
export interface CostPollError {
  message: string;
  /** Provider page that fixes a setup problem, when the plugin knows one. */
  helpLink: { label: string; url: string } | null;
}

/** One account's cost capability + collection state (GET /costs/status). */
export interface CostAccountStatus {
  accountId: string;
  pluginId: string;
  displayName: string;
  supportsCosts: boolean;
  periodNative: boolean;
  /**
   * The finer-grained dimensions this account's plugin can break spend down
   * by — straight off its cost capability, so the picker can't offer a
   * dimension the provider has never heard of.
   */
  dimensions: CostCapabilityDeclaration["dimensions"];
  /**
   * Whether this account's plugin can tell one kind of charge from another. An
   * org where nothing declares it has a charge-type breakdown that is a single
   * "Usage" bar, which is worse than not offering it.
   */
  chargeTypes: boolean;
  /**
   * Whether this account's plugin reports amortized amounts. The amortized view
   * is offered only when at least one connected account says yes — otherwise it
   * is the cash numbers under a different name, and a user who switched to it
   * would reasonably conclude the feature is broken.
   */
  amortization: boolean;
  /**
   * Whether this account's amounts are computed by the plugin (inventory × a
   * rate card, or usage × published list prices) rather than reported as billed
   * spend by the provider.
   *
   * Surfaced wherever the collection notices are, because an estimate differs
   * from an invoice in ways that only ever run one way: resources deleted
   * mid-period are missing, every rate is list, and credits, tax and refunds
   * are absent entirely.
   */
  estimated: boolean;
  costLastPolledAt: string | null;
  costBackfilledAt: string | null;
  costPollFailureCount: number;
  costPollError: CostPollError | null;
  coverage: { firstDay: string; lastDay: string } | null;
}

/** The accounts a failure notice should talk about, in display order. */
export function failingCostAccounts(statuses: CostAccountStatus[]): CostAccountStatus[] {
  return statuses.filter((s) => s.supportsCosts && s.costPollError);
}

/**
 * Accounts that collected cleanly and still have no spend data at all.
 *
 * Collection can succeed and return nothing: a Cloud Billing BigQuery export
 * enabled hours ago is correctly configured but emits no rows until Google's
 * pipeline catches up. Every stored field on such an account looks healthy —
 * no error, a recent poll — so the only evidence is the absent coverage, and
 * without saying so the surface is a blank graph that reads as a bug.
 *
 * `costLastPolledAt` gates it so an account that has never run yet stays
 * quiet rather than announcing emptiness it hasn't earned.
 */
export function emptyCostAccounts(statuses: CostAccountStatus[]): CostAccountStatus[] {
  return statuses.filter(
    (s) => s.supportsCosts && !s.costPollError && s.costLastPolledAt !== null && !s.coverage,
  );
}

/**
 * Accounts whose spend Infrawrench computed rather than collected.
 *
 * These are not a fault — a provider with no billing API can only be priced
 * from its inventory and a rate card — but the resulting number is not the
 * invoice, and the ways it differs are systematic: anything deleted mid-period
 * is missing, every rate is list rather than negotiated, and credits, tax and
 * refunds have nothing to attach to. A total that silently mixes computed and
 * billed money is the thing worth preventing, so every surface that shows one
 * says which accounts contributed the computed part.
 *
 * `supportsCosts` gates it: an account with no cost capability contributes no
 * spend at all, estimated or otherwise.
 */
export function estimatedCostAccounts(statuses: CostAccountStatus[]): CostAccountStatus[] {
  return statuses.filter((s) => s.supportsCosts && s.estimated);
}

/* ------------------------------------------------------------------ *
 * Widget configuration — what a dashboard stores for a cost card.
 * ------------------------------------------------------------------ */

export const COST_DIMENSIONS = [
  "provider",
  "account",
  "service",
  "region",
  "resource",
  "tag",
  "charge_type",
  "commitment",
] as const;
export type CostDimensionId = (typeof COST_DIMENSIONS)[number];

/**
 * What a cost row is, as opposed to what it costs — the client-side mirror of
 * the plugin contract's `CostChargeType`.
 *
 * Rows collected before charge types existed, and every plugin that cannot tell
 * one kind of charge from another, read as `usage`. That is the honest default:
 * it is what those rows were always assumed to be.
 *
 * `commitment_covered_usage` is consumption a reservation or savings plan
 * covered — still consumption, so it sits next to `usage` rather than next to
 * `commitment_discount`. It is separated out because it is what commitment
 * coverage is measured from: most providers can say *that* an hour was covered
 * without saying *which* commitment covered it.
 */
export const COST_CHARGE_TYPES = [
  "usage",
  "commitment_covered_usage",
  "commitment_fee",
  "commitment_discount",
  "credit",
  "tax",
  "refund",
  "adjustment",
  "support",
  "other",
] as const;
export type CostChargeType = (typeof COST_CHARGE_TYPES)[number];

export const COST_CHARGE_TYPE_LABELS: Record<CostChargeType, string> = {
  usage: "Usage",
  commitment_covered_usage: "Commitment-covered usage",
  commitment_fee: "Commitment fee",
  commitment_discount: "Commitment discount",
  credit: "Credit",
  tax: "Tax",
  refund: "Refund",
  adjustment: "Adjustment",
  support: "Support",
  other: "Other",
};

/**
 * Which number a cost query sums.
 *
 * - `cash` — what the provider charged on the day it charged it. This is the
 *   bank statement, and it is what every query did before amortization existed.
 * - `amortized` — commitment fees spread across the term they buy, so a year of
 *   capacity bought on one day is counted on the days it covers.
 *
 * Neither is wrong; they answer different questions. Cash answers "what left
 * the account in July"; amortized answers "what did July cost us". For an org
 * holding reservations or savings plans they can differ by the entire value of
 * a purchase, and a cash-only view makes the purchase month look like a
 * catastrophe and every month after it look free.
 *
 * Providers that report no amortized amount fall back to their cash amount, so
 * an amortized query over a mixed estate is never missing their spend.
 */
export const COST_BASES = ["cash", "amortized"] as const;
export type CostBasis = (typeof COST_BASES)[number];

export const COST_BASIS_LABELS: Record<CostBasis, string> = {
  cash: "Cash",
  amortized: "Amortized",
};

export interface CostFilter {
  dimension: CostDimensionId;
  op: "in" | "not_in";
  values: string[];
  /** Required when dimension === "tag". */
  tagKey?: string | undefined;
}

export const COST_RANGE_PRESETS = [
  "7d",
  "30d",
  "90d",
  "mtd",
  "last_month",
  "qtd",
  "ytd",
  "12m",
] as const;
export type CostRangePreset = (typeof COST_RANGE_PRESETS)[number];

export type CostDateRange =
  { kind: "relative"; preset: CostRangePreset } | { kind: "absolute"; from: string; to: string };

export const COST_CHART_TYPES = ["stacked_bar", "multi_bar", "line", "area", "pie"] as const;
export type CostChartType = (typeof COST_CHART_TYPES)[number];

export const COST_BINNINGS = ["daily", "weekly", "monthly", "cumulative"] as const;
export type CostBinningId = (typeof COST_BINNINGS)[number];

export interface CostGraphConfig {
  version: 1;
  chartType: CostChartType;
  binning: CostBinningId;
  dateRange: CostDateRange;
  groupBy: "none" | CostDimensionId;
  /** Required when groupBy === "tag". */
  groupByTagKey?: string | undefined;
  filters: CostFilter[];
  /**
   * A saved cost filter (`saved-cost-filters.ts`) applied **by reference** and
   * AND-composed with `filters` at query time, server-side. Referencing rather
   * than copying is the point: editing the saved filter changes every graph
   * using it. A reference that fails to resolve makes the query error rather
   * than silently run unfiltered.
   */
  savedFilterId?: string | undefined;
  /** Groups beyond the top N fold into an "Other" series. */
  topN: number;
  comparePreviousPeriod: boolean;
  showForecast: boolean;
  /**
   * Which number to sum. Absent is `cash` — the basis every graph authored
   * before amortization existed was drawn on, so an old widget keeps showing
   * exactly what it showed.
   */
  costBasis?: CostBasis | undefined;
}

/** A budget widget is a dashboard view onto a budgets row — alerts outlive it. */
export interface BudgetWidgetConfig {
  version: 1;
  budgetId: string;
}

export interface BudgetThreshold {
  type: "actual" | "forecast";
  /** Percent of the budget amount at which this threshold fires (1–1000). */
  percent: number;
}

/**
 * Create/update payload for a budget (POST/PUT /budgets). `ui/src/cost/config.ts`
 * asserts `budgetInputSchema` still parses to exactly this.
 */
export interface BudgetInput {
  name: string;
  amountCents: number;
  currency: string;
  filters: CostFilter[];
  /**
   * A saved cost filter applied by reference, AND-composed with `filters` when
   * the budget is evaluated. Absent means none; a PUT that omits it clears it
   * (budget updates are full replaces). A budget whose reference fails to
   * resolve errors its evaluation rather than silently measuring all spend —
   * un-scoping a budget could fire or suppress alerts.
   */
  savedFilterId?: string | undefined;
  thresholds: BudgetThreshold[];
  /**
   * Which number the budget tracks. Absent is `cash`, so every budget written
   * before this existed keeps measuring what it was measuring.
   *
   * An org holding commitments usually wants `amortized`: a cash budget is
   * blown the month a reservation is bought and then reads as under-spent for
   * the rest of the term, which is the opposite of an alert being useful.
   */
  costBasis?: CostBasis | undefined;
}

/** One selectable value in a dimension picker (GET /costs/dimensions). */
export interface CostDimensionOption {
  value: string;
  label: string;
}

/* ------------------------------------------------------------------ *
 * Editor defaults and labels — every host that can author a cost card
 * offers the same starting point and calls each option the same thing.
 * ------------------------------------------------------------------ */

export const DEFAULT_COST_GRAPH_CONFIG: CostGraphConfig = {
  version: 1,
  chartType: "stacked_bar",
  binning: "daily",
  dateRange: { kind: "relative", preset: "30d" },
  groupBy: "provider",
  filters: [],
  topN: 5,
  comparePreviousPeriod: false,
  showForecast: false,
};

export const DEFAULT_BUDGET_INPUT: BudgetInput = {
  name: "",
  amountCents: 100000,
  currency: "USD",
  filters: [],
  thresholds: [
    { type: "actual", percent: 80 },
    { type: "actual", percent: 100 },
  ],
};

export const COST_CHART_TYPE_LABELS: Record<CostChartType, string> = {
  stacked_bar: "Stacked bar",
  multi_bar: "Multi bar",
  line: "Line",
  area: "Area",
  pie: "Pie",
};

export const COST_BINNING_LABELS: Record<CostBinningId, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  cumulative: "Cumulative",
};

export const COST_RANGE_PRESET_LABELS: Record<CostRangePreset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  mtd: "Month to date",
  last_month: "Last month",
  qtd: "Quarter to date",
  ytd: "Year to date",
  "12m": "Last 12 months",
};

export const COST_DIMENSION_LABELS: Record<CostDimensionId, string> = {
  provider: "Provider",
  account: "Account",
  service: "Service",
  region: "Region",
  resource: "Resource",
  tag: "Tag",
  charge_type: "Charge type",
  commitment: "Commitment",
};

/**
 * `cost_graph` stores its whole config inline (a one-off card); `cost_report`
 * points at a saved `cost_reports` row by id, so editing the report updates
 * every dashboard showing it. Both are kept: naming and filing a report should
 * not be the price of putting one chart on one dashboard.
 */
export const DASHBOARD_WIDGET_KINDS = [
  "cost_graph",
  "cost_report",
  "budget",
  "custom_graph",
] as const;
export type DashboardWidgetKind = (typeof DASHBOARD_WIDGET_KINDS)[number];

/** Widget row shape shared by API responses and the dashboard UIs. */
export interface DashboardWidget {
  id: string;
  dashboardId: string;
  kind: DashboardWidgetKind;
  title: string;
  config: CostGraphConfig | CostReportWidgetConfig | BudgetWidgetConfig | CustomGraphWidgetConfig;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
}

/** Budget list row as returned by GET /budgets (with current-month status). */
export interface BudgetWithStatus {
  id: string;
  name: string;
  amountCents: number;
  currency: string;
  filters: CostFilter[];
  thresholds: BudgetThreshold[];
  /**
   * The basis `actualCents` and `forecastCents` were measured on. Optional so a
   * client a release ahead of its server still renders the row; absent reads as
   * cash, which is what such a server was measuring.
   */
  costBasis?: CostBasis | undefined;
  /**
   * The saved cost filter AND-composed with `filters` when the budget is
   * evaluated, or null. Optional so a client a release ahead of its server
   * still renders the row.
   */
  savedFilterId?: string | null | undefined;
  /** Month the status covers, YYYY-MM. */
  month: string;
  actualCents: number;
  forecastCents: number | null;
  currentMonthEvents: Array<{
    id: string;
    thresholdType: "actual" | "forecast";
    thresholdPercent: number;
    triggeredAt: string;
  }>;
  /**
   * The dashboards carrying a card for this budget. A budget exists
   * independently of any dashboard — it keeps evaluating and alerting with no
   * card anywhere — so the Costs panel is its home and this is where it also
   * happens to be shown.
   */
  placements: BudgetPlacement[];
}

/** One dashboard card pointing at a budget, as listed on `BudgetWithStatus`. */
export interface BudgetPlacement {
  widgetId: string;
  dashboardId: string;
  dashboardName: string;
}

/* ------------------------------------------------------------------ *
 * Cost anomalies — GET /costs/anomalies.
 * ------------------------------------------------------------------ */

/** The breakdowns anomaly detection evaluates. */
export type CostAnomalyDimension = "provider" | "service";

/**
 * What kind of finding a row is.
 *
 * - `spike` — spend far above the key's own trailing baseline.
 * - `new_source` — a key that spent (effectively) nothing across the whole
 *   trailing window and suddenly has material spend. It can never be a
 *   `spike`: with a zero baseline there is no mean or sigma to exceed, and the
 *   observed-days guard silences brand-new keys on purpose.
 *
 * The two are mutually exclusive for a given (day, key): a row is judged as a
 * spike first, and only a key with no baseline at all can be a new source.
 */
export type CostAnomalyKind = "spike" | "new_source";

/**
 * A detected spend anomaly: one UTC day where a provider's or service's spend
 * cleared the trailing-baseline threshold (mean + N·stddev over the prior
 * 28 days, with an absolute floor), or where a key with no prior spend at all
 * started costing money. Detection runs server-side after each cost
 * collection; this row is what the anomalies list renders.
 */
export interface CostAnomaly {
  id: string;
  /** The anomalous day, YYYY-MM-DD (UTC). */
  day: string;
  /**
   * Which detection produced this row. Older rows, written before new-source
   * detection existed, read as `spike`.
   */
  kind: CostAnomalyKind;
  dimension: CostAnomalyDimension;
  /** The dimension's value — a plugin id or a service name. */
  dimensionKey: string;
  currency: string;
  actualCents: number;
  /** Trailing-window mean, in cents. Zero (or near it) for a `new_source`. */
  baselineCents: number;
  /**
   * The bar the day cleared, in cents: the baseline mean + N·stddev for a
   * `spike`, the new-source floor for a `new_source`.
   */
  thresholdCents: number;
  detectedAt: string;
  /** Null when delivery failed or the cooldown suppressed the notification. */
  notifiedAt: string | null;
  /**
   * Root-cause hints computed when the anomaly fired — what the change
   * timeline and audit log say happened in the anomaly's window ("12
   * gce-instance resources appeared", "Astrid ran workflow \"Nightly
   * rebuild\""), ranked, at most three. Empty for anomalies detected before
   * hints existed. Optional so a client a release ahead of its server still
   * renders the row.
   */
  hints?: string[];
}

export const COST_ANOMALY_DIMENSION_LABELS: Record<CostAnomalyDimension, string> = {
  provider: "Provider",
  service: "Service",
};

export const COST_ANOMALY_KIND_LABELS: Record<CostAnomalyKind, string> = {
  spike: "Spike",
  new_source: "New spend source",
};

/**
 * The window `GET /costs/anomalies?days=` accepts. Clients clamp to it so a
 * typo fails locally rather than as a 400 after the round trip.
 */
export const COST_ANOMALY_WINDOW = { minDays: 1, maxDays: 90, defaultDays: 30 } as const;

/**
 * "+173%" over the trailing baseline, or null when there is no baseline to be
 * up from.
 *
 * A `new_source` never gets a percentage, **whatever its stored baseline
 * rounds to**: a key that spent a few sub-cent trial amounts across the window
 * has a baseline of one cent, and dividing by it prints a six-figure
 * percentage; a true zero prints `Infinity`. Neither is the fact that matters,
 * which is that the thing is new. Every surface renders `new` instead.
 */
export function costAnomalyDeltaPercent(
  anomaly: Pick<CostAnomaly, "kind" | "actualCents" | "baselineCents">,
): string | null {
  if (anomaly.kind === "new_source") return null;
  if (!(anomaly.baselineCents > 0)) return null;
  const pct = ((anomaly.actualCents - anomaly.baselineCents) / anomaly.baselineCents) * 100;
  if (!Number.isFinite(pct)) return null;
  return `+${Math.round(pct)}%`;
}

/**
 * Recently detected spend anomalies, newest day first (`GET /costs/anomalies`,
 * permission `costs:read`). Detection itself runs server-side after each cost
 * collection pass — there is nothing to trigger from a client.
 */
export async function listCostAnomalies(
  api: CloudFetch,
  orgId: string,
  days: number = COST_ANOMALY_WINDOW.defaultDays,
): Promise<CostAnomaly[]> {
  const clamped = Math.min(
    Math.max(Math.round(days), COST_ANOMALY_WINDOW.minDays),
    COST_ANOMALY_WINDOW.maxDays,
  );
  const res = await api.org<{ anomalies: CostAnomaly[] }>(
    orgId,
    `/costs/anomalies?days=${clamped}`,
  );
  return res?.anomalies ?? [];
}

/* ------------------------------------------------------------------ *
 * Anomaly tuning — GET/PUT /costs/anomaly-settings.
 * ------------------------------------------------------------------ */

/**
 * The per-org knobs on anomaly detection. Everything else about the model —
 * the 28-day baseline, the 3-day re-judged window, the 7-day cooldown, the
 * 7-observed-day guard — is fixed, because those are properties of the data
 * rather than a preference.
 *
 * Money is in cents and denominated in USD; the detector converts each floor
 * into the currency of the series it is judging, so one setting means the same
 * real amount whether a provider bills in dollars or yen.
 */
/**
 * Which anomalies, if any, also page the org's Twilio recipients by SMS.
 *
 * Deliberately one nested choice rather than two orthogonal booleans. The three
 * values order themselves — off ⊂ new sources ⊂ everything — so there is never
 * a combination that needs two different text messages out of one evaluation
 * pass, and the middle value is the one worth having: a spend source appearing
 * from nothing is what a leaked key or a fat-fingered instance type looks like,
 * while a spike on an existing line is usually a busy day.
 */
export type CostAnomalySmsMode = "off" | "new_source" | "all";

export const COST_ANOMALY_SMS_MODES = ["off", "new_source", "all"] as const;

export const COST_ANOMALY_SMS_MODE_LABELS: Record<CostAnomalySmsMode, string> = {
  off: "Never",
  new_source: "New spend sources only",
  all: "Every anomaly",
};

export interface CostAnomalySettings {
  /**
   * How many standard deviations above its own trailing mean a day's spend
   * must land to count as a spike. Lower is more sensitive.
   */
  sigmas: number;
  /**
   * Minimum rise over the baseline mean before a spike alerts, in USD cents.
   * The statistical bar alone flags penny-scale noise as wildly unusual; this
   * is what keeps it quiet.
   */
  minDeltaCents: number;
  /**
   * Minimum first-day spend before a *new spend source* alerts, in USD cents.
   * A provider or service with no spend across the whole trailing window can
   * never clear a sigma bar, so it gets its own absolute floor instead.
   */
  newSourceMinCents: number;
  /**
   * Whether anomalies also text the org's Twilio recipients, and which kinds.
   * Defaults to `off`: every org with Twilio configured for budgets would
   * otherwise start receiving anomaly texts the day this shipped.
   *
   * One batched SMS per evaluation pass summarises whatever that pass alerted
   * on, so turning this on cannot turn a day where thirty services jump into
   * thirty text messages.
   */
  smsAlerts: CostAnomalySmsMode;
}

/**
 * What `GET`/`PUT /costs/anomaly-settings` answer with: the stored settings
 * plus one derived, read-only fact.
 *
 * `smsAlerts` on its own is not enough for a form to tell the truth — an org
 * can select "every anomaly" while having no Twilio credentials, or none of its
 * recipients opted into SMS, and nothing would ever be sent. The server knows;
 * the client cannot (the Twilio settings routes are `org:settings:write`, which
 * a `costs:read` member does not hold), so it is answered here.
 */
export interface CostAnomalySettingsView extends CostAnomalySettings {
  /**
   * True when a page raised right now could actually be delivered: paging is
   * enabled for the org, Twilio credentials and a from-number are stored, and
   * at least one recipient opted into SMS.
   */
  smsConfigured: boolean;
}

/**
 * Bounds the API enforces. They exist to keep a setting from turning detection
 * into either a pager storm or a permanent silence:
 *
 * - `sigmas` below 1 flags roughly a third of ordinary days; 0 flags every day
 *   that is a cent above average. Above 10 nothing short of a 10x jump fires.
 * - The floors must be positive — a floor of zero (or a negative one) removes
 *   the noise filter entirely — and are capped where a floor stops being a
 *   noise filter and starts being a way to switch detection off by accident.
 */
export const COST_ANOMALY_LIMITS = {
  sigmasMin: 1,
  sigmasMax: 10,
  /** $1 — below this the floor no longer filters penny noise. */
  minDeltaCentsMin: 100,
  /** $100,000/day. */
  minDeltaCentsMax: 10_000_000,
  newSourceMinCentsMin: 100,
  newSourceMinCentsMax: 10_000_000,
} as const;

/**
 * What an org that has never touched the settings gets — the values anomaly
 * detection shipped with, so leaving the form alone changes nothing.
 */
export const DEFAULT_COST_ANOMALY_SETTINGS: CostAnomalySettings = {
  sigmas: 3,
  /** $10. */
  minDeltaCents: 1000,
  /**
   * $25. Deliberately above the spike floor: a spike is corroborated by the
   * key's own history, while a new source has none, so it should have to be
   * worth more before it wakes anyone.
   */
  newSourceMinCents: 2500,
  /** Opt-in. Turning an existing Twilio setup into a new pager is a surprise. */
  smsAlerts: "off",
};

/* ------------------------------------------------------------------ *
 * Change-based cost alerts — GET/POST/PUT/DELETE /cost-alerts.
 *
 * The third cost-alert family, deliberately distinct from the other two:
 * budgets alert on an absolute monthly total you chose; anomaly detection
 * alerts on unconfigured statistical outliers against a learned baseline;
 * change alerts alert on a *configured relative change* — "spend on this
 * scope moved more than X% (or $Y) versus the prior period" — on a scope
 * and cadence the user chose.
 * ------------------------------------------------------------------ */

/**
 * Which window is compared against which. The exact definitions (all
 * complete UTC days — the accruing current day never counts):
 *
 * - `daily` — one complete day vs the **same weekday one week earlier**
 *   (yesterday vs last Tuesday, not yesterday vs the day before), so weekday
 *   seasonality never reads as a change.
 * - `weekly` — the last 7 complete days vs the 7 complete days before them.
 * - `monthly` — month-to-date (the current month's complete days) vs the
 *   **same number of days** at the start of the prior month. Never MTD vs
 *   the full prior month — that comparison is always "down" until the 28th.
 */
export const COST_CHANGE_CADENCES = ["daily", "weekly", "monthly"] as const;
export type CostChangeCadence = (typeof COST_CHANGE_CADENCES)[number];

export const COST_CHANGE_CADENCE_LABELS: Record<CostChangeCadence, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

/** One line per cadence for editors, spelling out the exact comparison. */
export const COST_CHANGE_CADENCE_DESCRIPTIONS: Record<CostChangeCadence, string> = {
  daily: "Yesterday vs the same day last week",
  weekly: "Last 7 complete days vs the prior 7",
  monthly: "Month to date vs the same number of days last month",
};

export const COST_CHANGE_DIRECTIONS = ["increase", "decrease", "both"] as const;
export type CostChangeDirection = (typeof COST_CHANGE_DIRECTIONS)[number];

export const COST_CHANGE_DIRECTION_LABELS: Record<CostChangeDirection, string> = {
  increase: "Increases only",
  decrease: "Decreases only",
  both: "Either direction",
};

/** A change-based cost alert, as the API returns it. */
export interface CostAlert {
  id: string;
  name: string;
  /** Which cost rows count — same vocabulary as budget and graph filters. */
  filters: CostFilter[];
  /**
   * Per-group fan-out: null watches the scope's one total; a dimension
   * watches **each group** against its own prior window, so one alert covers
   * "any service that moves" and each offending group fires its own event.
   */
  groupBy: CostDimensionId | null;
  /** The tag key groups come from; only set when `groupBy === "tag"`. */
  groupByTagKey: string | null;
  cadence: CostChangeCadence;
  /**
   * Percent of the prior window's spend the change must reach, or null.
   * At least one threshold is always set; when **both** are set, **both**
   * must hold before the alert fires — a 50% jump on $2 pages nobody.
   */
  thresholdPercent: number | null;
  /** Cents the change must reach, or null. */
  thresholdAmountCents: number | null;
  direction: CostChangeDirection;
  enabled: boolean;
  /** When evaluation last looked at this alert (fired or not). */
  lastEvaluatedAt: string | null;
  /** When the alert last fired an event, or null when it never has. */
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create/update payload (POST/PUT /cost-alerts). */
export interface CostAlertInput {
  name: string;
  filters: CostFilter[];
  groupBy: CostDimensionId | null;
  /** Required when `groupBy === "tag"`. */
  groupByTagKey?: string | undefined;
  cadence: CostChangeCadence;
  thresholdPercent: number | null;
  thresholdAmountCents: number | null;
  direction: CostChangeDirection;
  enabled: boolean;
}

/** Bounds the API enforces; clients enforce the same ones locally. */
export const COST_ALERT_LIMITS = {
  maxNameLength: 120,
  /** 1% .. 10000% — a 100x move is the largest sane percent threshold. */
  minPercent: 1,
  maxPercent: 10_000,
  maxAlertsPerOrg: 200,
  /** GET /cost-alerts/events?limit= bounds. */
  minEventsLimit: 1,
  maxEventsLimit: 200,
  defaultEventsLimit: 50,
} as const;

export const DEFAULT_COST_ALERT_INPUT: CostAlertInput = {
  name: "",
  filters: [],
  groupBy: null,
  cadence: "weekly",
  thresholdPercent: 25,
  // Both thresholds by default: percent finds the movement, the absolute
  // floor keeps a 50%-of-nearly-nothing jump from firing.
  thresholdAmountCents: 10_000,
  direction: "increase",
  enabled: true,
};

/**
 * One fired comparison: the current window's spend against the prior
 * window's, for one group (or the whole scope) in one currency.
 */
export interface CostAlertEvent {
  id: string;
  alertId: string;
  /** The alert's name at read time; "" when the alert was since deleted. */
  alertName: string;
  /** Cadence period the current window belongs to — the dedup key. */
  periodKey: string;
  /** Current window, inclusive UTC days. */
  windowFrom: string;
  windowTo: string;
  /** Prior window it was compared against, inclusive UTC days. */
  previousFrom: string;
  previousTo: string;
  /** The offending group; "" when the alert watches one total. */
  groupKey: string;
  currency: string;
  previousAmountCents: number;
  currentAmountCents: number;
  /**
   * Signed percent change, rounded. Null when the prior window had no spend
   * at all — new spend has no percentage, only an amount. -100 when the
   * group vanished.
   */
  changePercent: number | null;
  direction: "increase" | "decrease";
  firedAt: string;
  notifiedAt: string | null;
}

/**
 *"+173%", "-42%", or "new" for spend with no prior window to be up from.
 * Every surface renders the null-percent case as `new` — a made-up huge
 * percentage buries the fact that matters, which is that the thing is new.
 */
export function costAlertEventDeltaLabel(event: Pick<CostAlertEvent, "changePercent">): string {
  if (event.changePercent === null) return "new";
  const rounded = Math.round(event.changePercent);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/** The org's change alerts (`GET /cost-alerts`, permission `costs:read`). */
export async function listCostAlerts(api: CloudFetch, orgId: string): Promise<CostAlert[]> {
  const res = await api.org<{ alerts: CostAlert[] }>(orgId, "/cost-alerts");
  return res?.alerts ?? [];
}

/**
 * Recently fired change-alert events, newest first
 * (`GET /cost-alerts/events`, permission `costs:read`). Optionally scoped to
 * one alert.
 */
export async function listCostAlertEvents(
  api: CloudFetch,
  orgId: string,
  options: { alertId?: string; limit?: number } = {},
): Promise<CostAlertEvent[]> {
  const limit = Math.min(
    Math.max(
      Math.round(options.limit ?? COST_ALERT_LIMITS.defaultEventsLimit),
      COST_ALERT_LIMITS.minEventsLimit,
    ),
    COST_ALERT_LIMITS.maxEventsLimit,
  );
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.alertId) params.set("alertId", options.alertId);
  const res = await api.org<{ events: CostAlertEvent[] }>(
    orgId,
    `/cost-alerts/events?${params.toString()}`,
  );
  return res?.events ?? [];
}

/* ------------------------------------------------------------------ *
 * Query contract — POST /costs/query.
 * ------------------------------------------------------------------ */

/** The cost query the API accepts — a graph config resolved to concrete dates. */
export interface CostQueryRequest {
  /** Inclusive, YYYY-MM-DD. */
  from: string;
  to: string;
  binning: CostBinningId;
  groupBy: "none" | CostDimensionId;
  groupByTagKey?: string | undefined;
  filters: CostFilter[];
  /**
   * The same filter written in the cost query language
   * (`cost-query-language.ts`) — `provider = 'aws' AND tag['env'] != 'dev'`.
   *
   * An *alternative* spelling of `filters`, never an addition to it: the server
   * compiles this to `CostFilter[]` and runs exactly the query the structured
   * form would have run. Sending both a query and a non-empty `filters` is an
   * error rather than a precedence rule — a caller that sets two filters and
   * silently gets one of them is the failure this is designed to avoid.
   */
  query?: string | undefined;
  /**
   * A saved cost filter (`saved-cost-filters.ts`) resolved **server-side** and
   * AND-composed with whichever inline spelling is present (`filters` or
   * `query`). Unlike those two it is not an alternative but a composition —
   * "the saved 'prod only' scope, further narrowed to this service" is the
   * intended use. An id that fails to resolve is an error, never a silent
   * fall-through to unfiltered spend.
   */
  savedFilterId?: string | undefined;
  topN: number;
  comparePreviousPeriod: boolean;
  forecast: boolean;
  /** Which number to sum; absent is `cash`. */
  costBasis?: CostBasis | undefined;
  /**
   * Restrict to these charge types. Absent is all of them — including the
   * credits and refunds that make a total net rather than gross.
   */
  chargeTypes?: CostChargeType[] | undefined;
  /**
   * Convert every currency the org holds a rate for into this one, so a
   * mixed-currency org gets a single number.
   *
   * **Absent is the default and means no conversion at all** — the response is
   * byte-identical to what a server that never heard of this field returns.
   * Present, it is opt-in twice over: the org must also have stated the rates,
   * because Infrawrench never fetches live FX. A currency the org has no rate
   * for is *not* dropped; it survives as its own series and its own `totals`
   * entry and is named in `CostQueryResponse.conversion.unconverted`.
   */
  displayCurrency?: string | undefined;
}

export interface CostSeriesPoint {
  /** Bucket start date, YYYY-MM-DD. */
  bucket: string;
  amount: number;
}

export interface CostQuerySeries {
  /** Group value ("" when ungrouped); "__other__" for the folded remainder. */
  key: string;
  /** Display label resolved server-side (account names, provider names). */
  label: string;
  currency: string;
  points: CostSeriesPoint[];
}

/**
 * One rate that was actually applied, and the day it started applying.
 *
 * `rate` is the decimal the org stated, as a number: multiply an amount in
 * `from` by it to get the amount in the display currency. `effectiveFrom` is
 * the stored rate row's date, so a reader can see *which* of the org's rates
 * produced a number rather than having to trust that some rate did.
 */
export interface CostConversionRate {
  /** Inclusive `YYYY-MM-DD` the rate started applying from. */
  effectiveFrom: string;
  rate: number;
}

/** A currency that was folded into the display currency, and how. */
export interface CostConvertedCurrency {
  currency: string;
  /**
   * Every rate applied across the queried range, newest `effectiveFrom` first.
   * More than one entry means the range spans a rate change — the amounts are
   * a sum of days converted at different rates, which is the point of storing
   * an effective date at all, and which a caveat line should say out loud.
   */
  rates: CostConversionRate[];
}

/**
 * What a converted response did, so every surface can label the number.
 *
 * Present only when the request asked for a `displayCurrency` **and** the org
 * has a display currency configured. Its absence means nothing was converted
 * and the per-currency shape is the literal stored one.
 */
export interface CostConversion {
  /** The currency converted amounts are expressed in. */
  displayCurrency: string;
  /**
   * Currencies folded into `displayCurrency`. Never includes the display
   * currency itself — spend already in it is passed through untouched, not
   * multiplied by a rate of 1.
   */
  converted: CostConvertedCurrency[];
  /**
   * Currencies present in the data that the org has no rate for. These are
   * **left in their own currency**, not dropped: they keep their own series
   * and their own `totals` entry. Silently omitting them would understate the
   * total, which is a worse failure than showing two numbers.
   */
  unconverted: string[];
}

export interface CostQueryResponse {
  series: CostQuerySeries[];
  /** Same query shifted back one full period, when requested. */
  comparison?: CostQuerySeries[];
  /** Projected daily totals beyond the last observed day, when requested. */
  forecast?: CostSeriesPoint[];
  /** Distinct currencies present — length > 1 means mixed-currency display. */
  currencies: string[];
  /** Period total per currency. */
  totals: Record<string, number>;
  previousTotals?: Record<string, number>;
  /**
   * Set when amounts above were converted. Absent means they are exactly as
   * collected — the two states must stay distinguishable, because a converted
   * total that does not say so is worse than two unconverted totals.
   */
  conversion?: CostConversion;
}

/** Sentinel group key for the folded "Other" series. */
export const OTHER_GROUP_KEY = "__other__";

/* ------------------------------------------------------------------ *
 * Pure helpers — shared so every surface bins and labels alike.
 * ------------------------------------------------------------------ */

/**
 * Resolve a widget date range to inclusive ISO dates. Relative presets are
 * anchored to `today` (UTC). Used by the API layer too, so server and client
 * agree on preset semantics.
 */
export function resolveCostDateRange(
  range: CostDateRange,
  today = new Date(),
): { from: string; to: string } {
  if (range.kind === "absolute") return { from: range.from, to: range.to };
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const to = iso(today);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  switch (range.preset) {
    case "7d":
      return { from: iso(new Date(today.getTime() - 6 * 86_400_000)), to };
    case "30d":
      return { from: iso(new Date(today.getTime() - 29 * 86_400_000)), to };
    case "90d":
      return { from: iso(new Date(today.getTime() - 89 * 86_400_000)), to };
    case "mtd":
      return { from: iso(new Date(Date.UTC(y, m, 1))), to };
    case "last_month":
      return {
        from: iso(new Date(Date.UTC(y, m - 1, 1))),
        to: iso(new Date(Date.UTC(y, m, 0))),
      };
    case "qtd":
      return { from: iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1))), to };
    case "ytd":
      return { from: iso(new Date(Date.UTC(y, 0, 1))), to };
    case "12m":
      return { from: iso(new Date(Date.UTC(y - 1, m, today.getUTCDate()))), to };
  }
}

/** Turn a graph config into the query the API expects. */
export function costQueryForConfig(config: CostGraphConfig, today = new Date()): CostQueryRequest {
  const { from, to } = resolveCostDateRange(config.dateRange, today);
  return {
    from,
    to,
    binning: config.binning,
    groupBy: config.groupBy,
    ...(config.groupByTagKey ? { groupByTagKey: config.groupByTagKey } : {}),
    filters: config.filters,
    // Passed by reference so the server resolves it at query time — the whole
    // point of a saved filter is that the config never holds a copy.
    ...(config.savedFilterId ? { savedFilterId: config.savedFilterId } : {}),
    topN: config.topN,
    comparePreviousPeriod: config.comparePreviousPeriod,
    forecast: config.showForecast,
    // Omitted rather than defaulted to "cash": the server's default is the same
    // value, and sending it would make every pre-existing widget's request
    // differ from the one it used to send for no behavioural reason.
    ...(config.costBasis ? { costBasis: config.costBasis } : {}),
  };
}

/** Sum every series in a response bucket-wise into one total-per-bucket list. */
export function totalPerBucket(series: CostQuerySeries[]): CostSeriesPoint[] {
  const totals = new Map<string, number>();
  for (const s of series) {
    for (const p of s.points) totals.set(p.bucket, (totals.get(p.bucket) ?? 0) + p.amount);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([bucket, amount]) => ({ bucket, amount }));
}

/** Bucket daily forecast points to match the chart binning. */
export function binForecast(
  forecast: CostSeriesPoint[],
  binning: CostBinningId,
  lastActualCumulative?: number,
): CostSeriesPoint[] {
  if (binning === "daily") return forecast;
  if (binning === "cumulative") {
    let running = lastActualCumulative ?? 0;
    return forecast.map((p) => {
      running += p.amount;
      return { bucket: p.bucket, amount: running };
    });
  }
  const bucketOf = (day: string): string => {
    if (binning === "monthly") return `${day.slice(0, 7)}-01`;
    // Weekly, Monday-start — matches toStartOfWeek(day, 1) server-side.
    const d = new Date(`${day}T00:00:00.000Z`);
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  };
  const map = new Map<string, number>();
  for (const p of forecast)
    map.set(bucketOf(p.bucket), (map.get(bucketOf(p.bucket)) ?? 0) + p.amount);
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([bucket, amount]) => ({ bucket, amount }));
}

const formatterCache = new Map<string, Intl.NumberFormat>();

export function formatMoney(amount: number, currency: string): string {
  const key = `${currency}:${Math.abs(amount) < 10 ? 2 : 0}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
        maximumFractionDigits: Math.abs(amount) < 10 ? 2 : 0,
      });
    } catch {
      fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    }
    formatterCache.set(key, fmt);
  }
  return fmt.format(amount);
}

/** Short bucket label for axes: "Jul 5", "Jul 2026" for monthly bins. */
export function formatBucketLabel(bucket: string, binning: CostBinningId): string {
  const d = new Date(`${bucket}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return bucket;
  if (binning === "monthly") {
    return d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The month a budget's status covers, as "July 2026". */
export function formatBudgetMonth(month: string): string {
  const d = new Date(`${month}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return month;
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}
