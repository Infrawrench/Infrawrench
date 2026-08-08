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
] as const;
export type CostDimensionId = (typeof COST_DIMENSIONS)[number];

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
  /** Groups beyond the top N fold into an "Other" series. */
  topN: number;
  comparePreviousPeriod: boolean;
  showForecast: boolean;
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
  thresholds: BudgetThreshold[];
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
};

export const DASHBOARD_WIDGET_KINDS = ["cost_graph", "budget", "custom_graph"] as const;
export type DashboardWidgetKind = (typeof DASHBOARD_WIDGET_KINDS)[number];

/** Widget row shape shared by API responses and the dashboard UIs. */
export interface DashboardWidget {
  id: string;
  dashboardId: string;
  kind: DashboardWidgetKind;
  title: string;
  config: CostGraphConfig | BudgetWidgetConfig | CustomGraphWidgetConfig;
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
  topN: number;
  comparePreviousPeriod: boolean;
  forecast: boolean;
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
    topN: config.topN,
    comparePreviousPeriod: config.comparePreviousPeriod,
    forecast: config.showForecast,
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
