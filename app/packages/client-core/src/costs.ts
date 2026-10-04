/**
 * The cost contract, shared by every client that renders cost data: the
 * collection status, the widget configuration a dashboard stores, the
 * `/costs/query` request and response, the budget row, and the pure helpers
 * that shape all of it for a chart.
 *
 * It lives here rather than in `@infrawrench/ui` because mobile doesn't depend
 * on that package: `ui/src/cost/config.ts` keeps the zod schemas (the API
 * validates against them) and re-exports these types, so web, desktop, mobile,
 * and the CLI all describe the same bytes.
 *
 * Collection runs daily in the background and backs off on failure, so a
 * misconfigured provider otherwise reads as a permanently empty graph: the
 * status types carry the reason (and the provider page that fixes it) out to
 * every surface.
 */

import type { CostCapabilityDeclaration, CostChargeType } from "@infrawrench/plugin-base";

import type { CostReportWidgetConfig } from "./cost-reports";
import type { CustomGraphWidgetConfig } from "./custom-graphs";
import type { CostCanvasWidgetConfig } from "./cost-canvases";
// Type-only, and deliberately one-way at runtime: `cost-scenarios.ts` is the
// module that knows what a scenario *is*, this one only knows that a query can
// carry one and a response can come back with one.
import type { CostScenarioProjection } from "./cost-scenarios";
// Same one-way, type-only relationship: `billing-rules.ts` is the module that
// knows what an adjustment *is*, this one only knows a query can ask for one
// and a response can come back describing what it did.
import type { CostAdjustmentSummary } from "./billing-rules";
import type { BudgetHierarchyWarning, BudgetMeasure, BudgetPeriod } from "./budgets";

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
   * by: straight off its cost capability, so the picker can't offer a
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
   * is offered only when at least one connected account says yes, otherwise it
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
 * pipeline catches up. Every stored field on such an account looks healthy
 * (no error, a recent poll) so the only evidence is the absent coverage, and
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
 * These are not a fault (a provider with no billing API can only be priced
 * from its inventory and a rate card) but the resulting number is not the
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
 * Widget configuration: what a dashboard stores for a cost card.
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
 * What a cost row is, as opposed to what it costs: the plugin contract's
 * `CostChargeType`, re-exported so clients name it from here. The ordered list
 * below is the client's own; `satisfies` rejects a name the contract lacks, and
 * the label map (keyed by the contract type) rejects one the list forgets.
 *
 * Rows collected before charge types existed, and every plugin that cannot tell
 * one kind of charge from another, read as `usage`. That is the honest default:
 * it is what those rows were always assumed to be.
 *
 * `commitment_covered_usage` is consumption a reservation or savings plan
 * covered: still consumption, so it sits next to `usage` rather than next to
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
] as const satisfies readonly CostChargeType[];
export type { CostChargeType };

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
 * - `cash`: what the provider charged on the day it charged it. This is the
 *   bank statement, and it is what every query did before amortization existed.
 * - `amortized`: commitment fees spread across the term they buy, so a year of
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
  "6m",
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
   * Overlay a scenario model (`cost-scenarios.ts`) on the forecast: known
   * future cost the trend cannot see, drawn as a second dashed line **beside**
   * the trend rather than instead of it.
   *
   * Only meaningful alongside `showForecast`, and `costQueryForConfig` drops it
   * when the forecast is off: a scenario with nothing to adjust is not a
   * silent no-op, it is a request the server refuses.
   *
   * Absent on every config written before scenarios existed, which is exactly
   * the graph those configs have always drawn.
   */
  scenarioModelId?: string | undefined;
  /**
   * Which number to sum. Absent is `cash`: the basis every graph authored
   * before amortization existed was drawn on, so an old widget keeps showing
   * exactly what it showed.
   */
  costBasis?: CostBasis | undefined;
  /**
   * Draw **cost per unit of a business metric** instead of cost, by dividing
   * this graph's spend by the metric's daily values. Absent (and it is absent
   * on every config written before unit costs existed) the graph is exactly
   * the spend graph it has always been.
   *
   * A mode on the existing config rather than a second widget kind, because
   * everything above still means what it meant: the date range, the binning,
   * the filters and the cost basis all describe the numerator. Only the four
   * options that presuppose a *stack of series* stop applying, and the card
   * ignores them rather than pretending otherwise: `groupBy` and `topN` (a
   * per-group ratio would need a per-group denominator the org has not
   * declared), `comparePreviousPeriod`, and `showForecast` (projecting a ratio
   * means projecting two independent series and dividing, which is not the
   * same thing as projecting one).
   *
   * The value is a metric **id**, not a key: a key can be renamed and the
   * stored card must not silently start dividing by a different metric.
   */
  unitCostMetricId?: string | undefined;
  /**
   * `unit_cost` (the default when a metric is set) or `margin`. Only meaningful
   * alongside `unitCostMetricId`, and margin is refused server-side for a
   * metric that is not revenue-shaped.
   */
  unitCostMode?: UnitCostGraphMode | undefined;
  /**
   * Draw the org's billing rules applied: markups, discounts, reallocations.
   *
   * Absent (and it is absent on every config written before billing rules
   * existed) draws collected spend, which is what those cards have always
   * drawn. When set, the card is required to label itself: the response carries
   * `adjustment` with the collected totals beside the adjusted ones, and
   * `CostGraphCard` renders that caption unconditionally.
   */
  adjusted?: boolean | undefined;
}

/**
 * The two ratios a unit-cost graph can draw. Spelled out here rather than
 * imported from `business-metrics.ts` so `CostGraphConfig` stays free of a
 * circular import; `UNIT_COST_MODES` there is asserted against it.
 */
export type UnitCostGraphMode = "unit_cost" | "margin";

/** A budget widget is a dashboard view onto a budgets row: alerts outlive it. */
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
   * resolve errors its evaluation rather than silently measuring all spend:
   * un-scoping a budget could fire or suppress alerts.
   */
  savedFilterId?: string | undefined;
  thresholds: BudgetThreshold[];
  /**
   * Opt this budget's **forecast** thresholds into a scenario model.
   *
   * Absent, and it is absent on every budget that existed before scenarios,
   * and on every budget nobody deliberately opts in: forecast thresholds keep
   * measuring the bare trend, exactly as they always have. That default is the
   * point: a hypothetical somebody typed into a scenario must not change when
   * real people get paged. Opting in is a deliberate act on this budget, it is
   * shown on the budget card and named in the alert body, and `actual`
   * thresholds are never affected at all: those measure money already spent,
   * which no scenario can touch.
   *
   * A PUT that omits it clears it; budget updates are full replaces.
   */
  scenarioModelId?: string | undefined;
  /**
   * Which number the budget tracks. Absent is `cash`, so every budget written
   * before this existed keeps measuring what it was measuring.
   *
   * An org holding commitments usually wants `amortized`: a cash budget is
   * blown the month a reservation is bought and then reads as under-spent for
   * the rest of the term, which is the opposite of an alert being useful.
   */
  costBasis?: CostBasis | undefined;
  /**
   * Measure this budget against **billing-rule-adjusted** spend (the internal
   * figure) instead of what the providers charged.
   *
   * Absent (false) on every budget until somebody says otherwise, for the same
   * reason `scenarioModelId` is: a markup is org policy and a budget threshold
   * pages a real person, so one settings row must not be able to move every
   * on-call rota in the org. Unlike a scenario this affects `actual` thresholds
   * too: an opted-in budget is measuring the internal number, and
   * month-to-date internal spend is as marked up as the forecast is.
   *
   * The alert body says the figure is adjusted and names the collected one; a
   * PUT that omits this clears it.
   */
  useAdjustedSpend?: boolean | undefined;
  /**
   * What the budget counts. Absent is `cost` (money, in `currency`); `usage`
   * sums the cost rows' usage quantity in `usageUnit` instead, against
   * `usageAmount`. `amountCents` is ignored by a usage budget.
   */
  measure?: BudgetMeasure | undefined;
  /** The usage unit a usage budget counts, exactly as providers report it. */
  usageUnit?: string | undefined;
  /** A usage budget's limit per period, in `usageUnit`. */
  usageAmount?: number | undefined;
  /**
   * Which periods the budget covers. Absent is the calendar month. An explicit
   * period list carries an amount per period, and the top-level amount is then
   * ignored.
   */
  period?: BudgetPeriod | undefined;
  /**
   * The budget this one rolls up into. A parent's actual and forecast are the
   * sum of its children's, measured over the parent's own period; it must
   * measure the same thing (currency, or usage unit) as its children.
   */
  parentBudgetId?: string | undefined;
}

/** One selectable value in a dimension picker (GET /costs/dimensions). */
export interface CostDimensionOption {
  value: string;
  label: string;
}

/* ------------------------------------------------------------------ *
 * Editor defaults and labels: every host that can author a cost card
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
  "6m": "Last 6 months",
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
  "cost_canvas",
] as const;
export type DashboardWidgetKind = (typeof DASHBOARD_WIDGET_KINDS)[number];

/** Widget row shape shared by API responses and the dashboard UIs. */
export interface DashboardWidget {
  id: string;
  dashboardId: string;
  kind: DashboardWidgetKind;
  title: string;
  config:
    | CostGraphConfig
    | CostReportWidgetConfig
    | BudgetWidgetConfig
    | CustomGraphWidgetConfig
    | CostCanvasWidgetConfig;
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
  /**
   * The scenario model this budget's forecast thresholds are measured against,
   * or null for the bare trend (the default, and what every budget did before
   * scenarios existed). Optional so a client a release ahead of its server
   * still renders the row.
   */
  scenarioModelId?: string | null | undefined;
  /** That model's name, so a card can say which assumptions are in the number. */
  scenarioModelName?: string | null | undefined;
  /**
   * True when every figure on this row has the org's billing rules applied:
   * the internal number rather than the collected one. False (the default) on
   * every budget nobody opted in.
   */
  useAdjustedSpend?: boolean | undefined;
  /**
   * Month-to-date **collected** spend, non-null only when `useAdjustedSpend`.
   *
   * Null on an unadjusted budget rather than a copy of `actualCents`: "there is
   * no separate collected figure because this one is it" and "the collected
   * figure happens to equal the adjusted one" are different facts, and a card
   * captioning every budget in the org would make the adjusted ones invisible.
   */
  rawActualCents?: number | null | undefined;
  /** Month the status covers, YYYY-MM. */
  month: string;
  actualCents: number;
  /**
   * The **unadjusted trend** forecast for the month. This stays the trend even
   * for a budget that opted into a scenario, so the two numbers are always
   * comparable and a card can show what the scenario moved.
   */
  forecastCents: number | null;
  /**
   * The scenario-adjusted month forecast: set only for a budget that opted
   * into a model, and the number its forecast thresholds are actually judged
   * against. Null (or absent) means the thresholds used `forecastCents`.
   */
  scenarioForecastCents?: number | null | undefined;
  currentMonthEvents: Array<{
    id: string;
    thresholdType: "actual" | "forecast";
    thresholdPercent: number;
    triggeredAt: string;
  }>;
  /**
   * The dashboards carrying a card for this budget. A budget exists
   * independently of any dashboard (it keeps evaluating and alerting with no
   * card anywhere) so the Costs panel is its home and this is where it also
   * happens to be shown.
   */
  placements: BudgetPlacement[];
  /*
   * Everything below is optional so a client a release ahead of its server
   * still renders the row; absent reads as a monthly spend budget with no
   * parent, which is what such a server was measuring.
   */
  /** What the budget counts; absent is `cost`. */
  measure?: BudgetMeasure | undefined;
  usageUnit?: string | null | undefined;
  usageAmount?: number | null | undefined;
  /** The configured periods; null is the calendar month. */
  period?: BudgetPeriod | null | undefined;
  parentBudgetId?: string | null | undefined;
  /**
   * The period being measured, inclusive `YYYY-MM-DD`. Null when the budget's
   * periods do not cover today (a cadence not yet started, a gap in an
   * explicit list): nothing is measured and no threshold can fire.
   */
  periodStart?: string | null | undefined;
  periodEnd?: string | null | undefined;
  /**
   * This period's limit in the budget's unit: cents for a spend budget, the
   * quantity for a usage budget. Differs from `amountCents` for an explicit
   * period list (each period has its own) and for a usage budget.
   */
  periodLimit?: number | null | undefined;
  /** Period-to-date usage, for a usage budget (null otherwise). */
  actualUsage?: number | null | undefined;
  /** Projected period-end usage, for a usage budget (null otherwise). */
  forecastUsage?: number | null | undefined;
  /**
   * True when this budget has children, so its figures are the sum of theirs
   * over its period rather than a measurement of its own scope.
   */
  rolledUp?: boolean | undefined;
  /** Number of direct child budgets. */
  childCount?: number | undefined;
  /** Where this budget's children outgrow it. Empty for a leaf. */
  hierarchyWarnings?: BudgetHierarchyWarning[] | undefined;
}

/** One dashboard card pointing at a budget, as listed on `BudgetWithStatus`. */
export interface BudgetPlacement {
  widgetId: string;
  dashboardId: string;
  dashboardName: string;
}

/* ------------------------------------------------------------------ *
 * Query contract: POST /costs/query.
 * ------------------------------------------------------------------ */

/** The cost query the API accepts: a graph config resolved to concrete dates. */
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
   * (`cost-query-language.ts`): `provider = 'aws' AND tag['env'] != 'dev'`.
   *
   * An *alternative* spelling of `filters`, never an addition to it: the server
   * compiles this to `CostFilter[]` and runs exactly the query the structured
   * form would have run. Sending both a query and a non-empty `filters` is an
   * error rather than a precedence rule: a caller that sets two filters and
   * silently gets one of them is the failure this is designed to avoid.
   */
  query?: string | undefined;
  /**
   * A saved cost filter (`saved-cost-filters.ts`) resolved **server-side** and
   * AND-composed with whichever inline spelling is present (`filters` or
   * `query`). Unlike those two it is not an alternative but a composition:
   * "the saved 'prod only' scope, further narrowed to this service" is the
   * intended use. An id that fails to resolve is an error, never a silent
   * fall-through to unfiltered spend.
   */
  savedFilterId?: string | undefined;
  topN: number;
  comparePreviousPeriod: boolean;
  forecast: boolean;
  /**
   * Apply a scenario model to the forecast, returning the adjusted projection
   * in `CostQueryResponse.scenario` **alongside** the untouched `forecast`.
   *
   * Requires `forecast: true`: sending a scenario with no forecast is a 400,
   * not a no-op. A caller who asked for assumptions to be applied and silently
   * got none back is the failure this feature is built to avoid.
   */
  scenarioModelId?: string | undefined;
  /** Which number to sum; absent is `cash`. */
  costBasis?: CostBasis | undefined;
  /**
   * Restrict to these charge types. Absent is all of them, including the
   * credits and refunds that make a total net rather than gross.
   */
  chargeTypes?: CostChargeType[] | undefined;
  /**
   * Convert every currency the org holds a rate for into this one, so a
   * mixed-currency org gets a single number.
   *
   * **Absent is the default and means no conversion at all**: the response is
   * byte-identical to what a server that never heard of this field returns.
   * Present, it is opt-in twice over: the org must also have stated the rates,
   * because Infrawrench never fetches live FX. A currency the org has no rate
   * for is *not* dropped; it survives as its own series and its own `totals`
   * entry and is named in `CostQueryResponse.conversion.unconverted`.
   */
  displayCurrency?: string | undefined;
  /**
   * Apply the org's [billing rules](./billing-rules.ts) (markups, discounts,
   * reallocations) to this answer.
   *
   * **Absent (the default) is raw collected spend**, byte-identical to what a
   * server that never heard of billing rules returns. Every unattended reader
   * (budgets, anomaly detection, change alerts, the digest, cost exports)
   * leaves it absent, because the safe default for anything that can page a
   * human is the number the provider actually billed.
   *
   * Present, the response carries `adjustment` with the collected totals beside
   * the adjusted ones and the rules that moved them. It is set even when the
   * org has no rules: its absence must mean "unadjusted" and nothing else.
   */
  adjusted?: boolean | undefined;
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
   * More than one entry means the range spans a rate change: the amounts are
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
   * currency itself: spend already in it is passed through untouched, not
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
  /**
   * The same projection with a scenario model applied: set only when the
   * request named one.
   *
   * Deliberately a *second* field rather than a replacement for `forecast`.
   * Both are returned together so a reader can always see what the trend said
   * before somebody's assumptions touched it; a response that quietly replaced
   * the trend with a hypothetical would be worse than no projection at all.
   */
  scenario?: CostScenarioProjection;
  /** Distinct currencies present: length > 1 means mixed-currency display. */
  currencies: string[];
  /** Period total per currency. */
  totals: Record<string, number>;
  previousTotals?: Record<string, number>;
  /**
   * Set when amounts above were converted. Absent means they are exactly as
   * collected: the two states must stay distinguishable, because a converted
   * total that does not say so is worse than two unconverted totals.
   */
  conversion?: CostConversion;
  /**
   * Set when the request asked to be `adjusted`. Absent means every number
   * above is exactly as collected.
   *
   * This is the whole raw-vs-adjusted contract in one field: an adjusted
   * response can never arrive without the collected totals (`rawTotals`) and
   * the list of rules that moved them, so no surface can render an adjusted
   * figure without being handed what it needs to label it.
   */
  adjustment?: CostAdjustmentSummary;
}

/** Sentinel group key for the folded "Other" series. */
export const OTHER_GROUP_KEY = "__other__";

/* ------------------------------------------------------------------ *
 * Pure helpers: shared so every surface bins and labels alike.
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
    case "6m":
      return { from: iso(new Date(Date.UTC(y, m - 6, today.getUTCDate()))), to };
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
    // Passed by reference so the server resolves it at query time: the whole
    // point of a saved filter is that the config never holds a copy.
    ...(config.savedFilterId ? { savedFilterId: config.savedFilterId } : {}),
    topN: config.topN,
    comparePreviousPeriod: config.comparePreviousPeriod,
    forecast: config.showForecast,
    // Dropped when the forecast is off: there is no projected region to adjust,
    // and the server rejects the combination rather than pretending otherwise.
    // The editor keeps the two in step, so this only fires for a config edited
    // by hand or by an older client.
    ...(config.showForecast && config.scenarioModelId
      ? { scenarioModelId: config.scenarioModelId }
      : {}),
    // Omitted rather than defaulted to "cash": the server's default is the same
    // value, and sending it would make every pre-existing widget's request
    // differ from the one it used to send for no behavioural reason.
    ...(config.costBasis ? { costBasis: config.costBasis } : {}),
    // Same rule: omitted rather than sent as `false`, so a card that never
    // asked for adjustments issues byte-identical requests to the ones it
    // always has.
    ...(config.adjusted ? { adjusted: true } : {}),
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

/**
 * The bucket a UTC day falls into, for a given binning.
 *
 * Must agree exactly with `bucketExpr` in `server-core/clickhouse/cost-readers`:
 * weekly is Monday-start to match `toStartOfWeek(day, 1)`, monthly is the
 * first of the month. Anything that has to line a client-side series up against
 * a server-aggregated one (the forecast splice, the unit-cost denominator)
 * calls this rather than re-deriving it, because a client that bucketed Sundays
 * differently would divide one week's spend by another week's volume and the
 * quotient would look entirely plausible.
 *
 * `cumulative` shares daily buckets: it is a running sum over them.
 */
export function costBucketStart(day: string, binning: CostBinningId): string {
  if (binning === "monthly") return `${day.slice(0, 7)}-01`;
  if (binning === "weekly") {
    const d = new Date(`${day}T00:00:00.000Z`);
    const dow = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  }
  return day;
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
  const bucketOf = (day: string): string => costBucketStart(day, binning);
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

export {
  BUDGET_MEASURES,
  BUDGET_MEASURE_LABELS,
  BUDGET_PERIOD_UNITS,
  BUDGET_PERIOD_UNIT_LABELS,
  BUDGET_LIMITS,
  BUDGET_HIERARCHY_WARNING_KINDS,
  addBudgetDays,
  budgetDaysBetween,
  budgetDepth,
  budgetDescendantIds,
  budgetInputError,
  budgetLimitForWindow,
  budgetPeriodsEqual,
  budgetProgress,
  budgetSubtreeHeight,
  budgetWithStatusToInput,
  buildBudgetTree,
  formatBudgetPeriodWindow,
  formatUsageQuantity,
  isBudgetDay,
  resolveBudgetPeriod,
  upcomingBudgetPeriod,
} from "./budgets";
export type {
  BudgetMeasure,
  BudgetPeriodUnit,
  BudgetRecurringPeriod,
  BudgetExplicitPeriod,
  BudgetExplicitPeriods,
  BudgetPeriod,
  BudgetPeriodWindow,
  BudgetTreeNode,
  BudgetHierarchyWarningKind,
  BudgetHierarchyWarning,
  BudgetProgress,
} from "./budgets";

export {
  EFFICIENCY_ALERT_KINDS,
  EFFICIENCY_ALERT_KIND_LABELS,
  COST_EFFICIENCY_LIMITS,
  DEFAULT_COST_EFFICIENCY_SETTINGS,
  getCostEfficiencySettings,
  listEfficiencyAlertEvents,
} from "./cost-efficiency";
export type {
  EfficiencyAlertKind,
  CostEfficiencySettings,
  EfficiencyAlertEvent,
} from "./cost-efficiency";

export {
  COST_CHANGE_CADENCES,
  COST_CHANGE_CADENCE_LABELS,
  COST_CHANGE_CADENCE_DESCRIPTIONS,
  COST_CHANGE_DIRECTIONS,
  COST_CHANGE_DIRECTION_LABELS,
  COST_ALERT_LIMITS,
  DEFAULT_COST_ALERT_INPUT,
  costAlertEventDeltaLabel,
  listCostAlerts,
  listCostAlertEvents,
} from "./cost-alerts";
export type {
  CostChangeCadence,
  CostChangeDirection,
  CostAlert,
  CostAlertInput,
  CostAlertEvent,
} from "./cost-alerts";

export {
  COST_ANOMALY_DIMENSION_LABELS,
  COST_ANOMALY_KIND_LABELS,
  COST_ANOMALY_WINDOW,
  costAnomalyDeltaPercent,
  listCostAnomalies,
  isCostAnomalyExplained,
  countUnexplainedCostAnomalies,
  acknowledgeCostAnomaly,
  COST_ANOMALY_SMS_MODES,
  COST_ANOMALY_SMS_MODE_LABELS,
  COST_ANOMALY_LIMITS,
  DEFAULT_COST_ANOMALY_SETTINGS,
} from "./cost-anomalies";
export type {
  CostAnomalyDimension,
  CostAnomalyKind,
  CostAnomalyAcknowledgement,
  CostAnomaly,
  CostAnomalySmsMode,
  CostAnomalySettings,
  CostAnomalySettingsView,
} from "./cost-anomalies";
