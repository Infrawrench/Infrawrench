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
  | { kind: "relative"; preset: CostRangePreset }
  | { kind: "absolute"; from: string; to: string };

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
 * A detected spend anomaly: one UTC day where a provider's or service's spend
 * cleared the trailing-baseline threshold (mean + N·stddev over the prior
 * 28 days, with an absolute floor). Detection runs server-side after each
 * cost collection; this row is what the anomalies list renders.
 */
export interface CostAnomaly {
  id: string;
  /** The anomalous day, YYYY-MM-DD (UTC). */
  day: string;
  dimension: CostAnomalyDimension;
  /** The dimension's value — a plugin id or a service name. */
  dimensionKey: string;
  currency: string;
  actualCents: number;
  /** Trailing-window mean, in cents. */
  baselineCents: number;
  /** The bar the day cleared (mean + N·stddev), in cents. */
  thresholdCents: number;
  detectedAt: string;
  /** Null when delivery failed or the cooldown suppressed the notification. */
  notifiedAt: string | null;
}

export const COST_ANOMALY_DIMENSION_LABELS: Record<CostAnomalyDimension, string> = {
  provider: "Provider",
  service: "Service",
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
