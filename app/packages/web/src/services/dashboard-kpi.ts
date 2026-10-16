/**
 * Dashboard KPI cards: answer one {@link KpiWidgetConfig}.
 *
 * Like a canvas KPI block, the card stores the question and this re-answers
 * it on every read, through the service the source's own card uses:
 * `runCostQuery` / `runUnitCostQuery` for a saved report (with the report's
 * filters, saved filter, basis and billing-rule choice), the budget resolver
 * for a budget, the commitments feed for coverage and utilization, and the
 * realized savings report for savings. Every one of those reads inside the
 * request's cost visibility scope and sharing principal, so a tile can never
 * show more than its reader could query by hand; the PDF and delivery paths
 * call in with their own (full-access) context, exactly as they do for the
 * other cost cards.
 *
 * The change badge compares with the same-length window immediately before
 * (`previousEqualWindow`), except where the source has a window of its own: a
 * budget compares with the same point of its previous period (or, for the
 * projection, with how the previous period ended), and commitment coverage
 * and utilization with the feed as it read one window ago.
 */
import {
  KPI_DEFAULT_DATE_RANGE,
  applyCostReportRunOverrides,
  costQueryForConfig,
  inclusiveDayCount,
  kpiChange,
  kpiUpIsGood,
  kpiWidgetConfigProblem,
  previousEqualWindow,
  primaryCostCurrency,
  primarySavingsTotal,
  resolveBudgetPeriod,
  resolveCostDateRange,
  unitCostQueryForConfig,
  type BudgetPeriod,
  type CostGraphConfig,
  type CostQueryRequest,
  type DashboardKpiResult,
  type DashboardKpiUnit,
  type KpiWidgetConfig,
  type KpiWidgetSource,
  type SavingsEventKind,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { getCommitmentsFeed } from "@infrawrench/server-core/commitments/feed";
import { getRealizedSavingsReport } from "@infrawrench/server-core/savings/realized";
import { getOrgCurrencySettings } from "@infrawrench/server-core/cost/currency-settings";
import { runCostQuery } from "./cost-query";
import { runUnitCostQuery, runUsageUnitCostQuery } from "./unit-cost-query";
import { budgetStatusAsOf, getBudgetWithStatus } from "./budgets";
import { getCostReport } from "./cost-reports";

/** A KPI that cannot be answered as configured: a 400 at the API, an error tile elsewhere. */
export class DashboardKpiError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
    this.name = "DashboardKpiError";
  }
}

export interface DashboardKpiOptions {
  /**
   * The caller's permissions; null is a system caller (PDF, delivery). A
   * budget KPI needs `budgets:read`, as on the budget's own route.
   */
  granted: readonly string[] | null;
  now?: Date | undefined;
}

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dayBefore = (day: string) => iso(new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS));
const addDays = (day: string, n: number) =>
  iso(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));

/** The figure and its window, before the comparison is attached. */
interface Measured {
  value: number | null;
  unit: DashboardKpiUnit;
  currency?: string | undefined;
  perUnit?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  sourceName?: string | undefined;
  limit?: number | null | undefined;
  note?: string | undefined;
}

async function displayCurrencyOf(organizationId: string): Promise<string | null> {
  return getOrgCurrencySettings(organizationId)
    .then((s) => s.displayCurrency)
    .catch(() => null);
}

function joinNotes(...notes: Array<string | undefined>): string | undefined {
  const kept = notes.filter((n): n is string => Boolean(n));
  return kept.length > 0 ? kept.join(" ") : undefined;
}

/* ------------------------------------------------------------------ *
 * Saved report
 * ------------------------------------------------------------------ */

type ReportSource = Extract<KpiWidgetSource, { kind: "cost_report" }>;

/** The report's spend, usage or distinct count over one window. */
async function reportTotal(
  organizationId: string,
  config: CostGraphConfig,
  source: ReportSource,
  window: { from: string; to: string },
  displayCurrency: string | null,
  now: Date,
): Promise<Measured> {
  const measure = source.measure as "cost" | "usage" | "count";
  const usageUnit =
    measure === "usage" ? (source.usageUnit ?? config.usageUnit ?? undefined) : undefined;
  if (measure === "usage" && !usageUnit) {
    throw new DashboardKpiError(
      "Pick a usage unit: this report does not measure usage in one unit of its own.",
    );
  }
  const viewed = applyCostReportRunOverrides(config, {
    measure,
    ...(usageUnit ? { usageUnit } : {}),
    cumulative: false,
  });
  if (measure === "count" && viewed.groupBy === "none") {
    throw new DashboardKpiError(
      "A distinct count needs a report grouped by a dimension; this report is not grouped.",
    );
  }
  const base = costQueryForConfig(
    { ...viewed, dateRange: { kind: "absolute", from: window.from, to: window.to } },
    now,
  );
  // One total over the window: a single bin, no stack, no overlays. Count
  // keeps the report's group-by, because that is what it counts.
  const request: CostQueryRequest = {
    ...base,
    binning: "monthly",
    groupBy: measure === "count" ? base.groupBy : "none",
    topN: 1,
    comparePreviousPeriod: false,
    forecast: false,
    ...(measure === "cost" && displayCurrency ? { displayCurrency } : {}),
  };
  delete request.scenarioModelId;
  delete request.cumulative;
  if (request.groupBy === "none") delete request.groupByTagKey;

  const response = await runCostQuery(organizationId, request);
  if (measure === "cost") {
    const currency = primaryCostCurrency(response) ?? displayCurrency ?? "USD";
    const others = response.currencies.filter((c) => c !== currency);
    return {
      value: response.totals[currency] ?? 0,
      unit: "money",
      currency,
      from: window.from,
      to: window.to,
      ...(others.length > 0 ? { note: `Also spend in ${others.join(", ")}, not included.` } : {}),
    };
  }
  return {
    value: response.totals[""] ?? 0,
    unit: measure === "usage" ? "quantity" : "count",
    ...(measure === "usage" ? { perUnit: usageUnit } : {}),
    from: window.from,
    to: window.to,
  };
}

/** Unit cost, or the business metric itself, over one window. */
async function reportUnitCost(
  organizationId: string,
  config: CostGraphConfig,
  source: ReportSource,
  window: { from: string; to: string },
  displayCurrency: string | null,
  now: Date,
): Promise<Measured> {
  const byUsage = config.unitCostMode === "usage_unit_cost";
  if (!config.unitCostMetricId && !byUsage) {
    throw new DashboardKpiError(
      "This report has no business metric attached. Attach one in the report's unit cost settings, or pick another measure.",
    );
  }
  if (source.measure === "business_metric" && byUsage) {
    throw new DashboardKpiError(
      "This report divides spend by provider usage, not by a business metric.",
    );
  }
  const base = unitCostQueryForConfig(
    { ...config, dateRange: { kind: "absolute", from: window.from, to: window.to } },
    now,
  );
  // One overall ratio: no label split, and the plain unit cost even when the
  // report charts a margin or the raw metric.
  const request = {
    ...base,
    binning: "monthly" as const,
    mode: byUsage ? ("usage_unit_cost" as const) : ("unit_cost" as const),
    ...(displayCurrency ? { displayCurrency } : {}),
  };
  delete request.groupByLabel;
  const response = byUsage
    ? await runUsageUnitCostQuery(organizationId, request)
    : await runUnitCostQuery(organizationId, config.unitCostMetricId!, request);
  const first = response.series[0];
  const metricName = response.metric?.name ?? response.usageUnit ?? "unit";
  const several =
    response.series.length > 1
      ? `Spend in ${response.series.length} currencies; showing ${first?.currency}.`
      : undefined;

  if (source.measure === "business_metric") {
    const metric = response.metric;
    const value = first?.overallMetricValue ?? null;
    return {
      value,
      ...(metric?.kind === "currency"
        ? { unit: "money" as const, currency: metric.currency ?? undefined }
        : { unit: "quantity" as const, perUnit: metric?.unit || metricName }),
      from: window.from,
      to: window.to,
      ...(value === null ? { note: `No ${metricName} values reported for this window.` } : {}),
    };
  }

  const value = first?.overallValue ?? null;
  const per = response.usageUnit ?? response.metric?.unit ?? metricName;
  return {
    value,
    unit: "money_per_unit",
    ...(first ? { currency: first.currency } : {}),
    perUnit: response.scale && response.scale !== 1 ? `${response.scale} ${per}` : per,
    from: window.from,
    to: window.to,
    note: joinNotes(
      value === null ? `No ${metricName} values reported for this window.` : undefined,
      several,
    ),
  };
}

async function reportKpi(
  organizationId: string,
  config: KpiWidgetConfig,
  source: ReportSource,
  now: Date,
): Promise<{ current: Measured; previous: Measured | null }> {
  const report = await getCostReport(organizationId, source.reportId);
  if (!report) {
    throw new DashboardKpiError("This saved report was deleted or is not shared with you.", 404);
  }
  const displayCurrency =
    source.measure === "cost" ||
    source.measure === "unit_cost" ||
    source.measure === "business_metric"
      ? await displayCurrencyOf(organizationId)
      : null;
  const window = resolveCostDateRange(config.dateRange ?? report.config.dateRange, now);
  const run = (w: { from: string; to: string }) =>
    source.measure === "unit_cost" || source.measure === "business_metric"
      ? reportUnitCost(organizationId, report.config, source, w, displayCurrency, now)
      : reportTotal(organizationId, report.config, source, w, displayCurrency, now);

  const [current, previous] = await Promise.all([
    run(window),
    config.comparePreviousPeriod
      ? run(previousEqualWindow(window.from, window.to))
      : Promise.resolve(null),
  ]);

  if (source.aggregation === "daily_average") {
    const average = (m: Measured): Measured => ({
      ...m,
      value:
        m.value === null || !m.from || !m.to ? m.value : m.value / inclusiveDayCount(m.from, m.to),
    });
    return {
      current: { ...average(current), sourceName: report.name },
      previous: previous ? average(previous) : null,
    };
  }
  return { current: { ...current, sourceName: report.name }, previous };
}

/* ------------------------------------------------------------------ *
 * Budget
 * ------------------------------------------------------------------ */

type BudgetSource = Extract<KpiWidgetSource, { kind: "budget" }>;

async function budgetKpi(
  organizationId: string,
  config: KpiWidgetConfig,
  source: BudgetSource,
  opts: DashboardKpiOptions,
  now: Date,
): Promise<{ current: Measured; previous: Measured | null }> {
  if (opts.granted !== null && !hasPermission(opts.granted, "budgets:read")) {
    throw new DashboardKpiError("Your role cannot see budgets (budgets:read).", 403);
  }
  const budget = await getBudgetWithStatus(organizationId, source.budgetId);
  if (!budget) {
    throw new DashboardKpiError("This budget was deleted or is not visible to you.", 404);
  }
  const usage = budget.measure === "usage";
  const scale = (v: number | null | undefined) =>
    v === null || v === undefined ? null : usage ? v : v / 100;
  const unitOf = (): Pick<Measured, "unit" | "currency" | "perUnit"> =>
    source.measure === "percent_used"
      ? { unit: "percent" }
      : usage
        ? { unit: "quantity", perUnit: budget.usageUnit ?? undefined }
        : { unit: "money", currency: budget.currency };

  /** One reading of a status, in the budget's major unit. */
  const read = (s: {
    actual: number;
    forecast: number | null;
    limit: number | null;
  }): number | null => {
    switch (source.measure) {
      case "actual":
        return s.actual;
      case "forecast":
        return s.forecast;
      case "remaining":
        return s.limit === null ? null : s.limit - s.actual;
      case "percent_used":
        return s.limit && s.limit > 0 ? (s.actual / s.limit) * 100 : null;
    }
  };

  const limit = scale(
    budget.periodLimit !== undefined
      ? budget.periodLimit
      : usage
        ? (budget.usageAmount ?? null)
        : budget.amountCents || null,
  );
  const currentForecast = usage
    ? (budget.forecastUsage ?? null)
    : scale(budget.scenarioForecastCents ?? budget.forecastCents);
  const current: Measured = {
    value:
      budget.periodStart === null || budget.periodStart === undefined
        ? null
        : read({
            actual: usage ? (budget.actualUsage ?? 0) : budget.actualCents / 100,
            forecast: currentForecast,
            limit,
          }),
    ...unitOf(),
    ...(budget.periodStart ? { from: budget.periodStart } : {}),
    ...(budget.periodEnd ? { to: budget.periodEnd } : {}),
    sourceName: budget.name,
    limit: source.measure === "percent_used" ? null : limit,
    ...(budget.periodStart ? {} : { note: "No budget period covers today." }),
  };

  if (!config.comparePreviousPeriod || !budget.periodStart) return { current, previous: null };
  // The previous period, as the budget's own cadence defines it: a gap in an
  // explicit list means there is nothing to compare with, not a zero.
  const previousWindow = resolveBudgetPeriod(
    (budget.period ?? null) as BudgetPeriod | null,
    dayBefore(budget.periodStart),
  );
  if (!previousWindow) return { current, previous: null };
  // The projection is compared with how the previous period ended; every
  // other reading with the same point of it, so a half-spent month is not
  // set against a whole one.
  const elapsed = inclusiveDayCount(budget.periodStart, iso(now)) - 1;
  const asOfDay =
    source.measure === "forecast"
      ? previousWindow.end
      : [addDays(previousWindow.start, elapsed), previousWindow.end].sort()[0]!;
  const prior = await budgetStatusAsOf(organizationId, budget.id, new Date(`${asOfDay}T12:00:00Z`));
  if (!prior) return { current, previous: null };
  const priorActual = usage ? (prior.actualUsage ?? 0) : prior.actualCents / 100;
  const previous: Measured = {
    value: read({
      actual: priorActual,
      // The previous period's outcome is what a projection is set against.
      forecast: priorActual,
      limit: scale(prior.limit),
    }),
    ...unitOf(),
    ...(prior.periodStart ? { from: prior.periodStart } : {}),
    to: asOfDay,
  };
  return { current, previous };
}

/* ------------------------------------------------------------------ *
 * Commitments and realized savings
 * ------------------------------------------------------------------ */

async function savingsTotal(
  organizationId: string,
  window: { from: string; to: string },
  eventKind: SavingsEventKind | undefined,
  now: Date,
): Promise<Measured> {
  const report = await getRealizedSavingsReport(organizationId, { ...window, now });
  if (eventKind) {
    const buckets = report.byKind.filter((b) => b.key === eventKind);
    const top = [...buckets].sort((a, b) => b.realized - a.realized)[0];
    return {
      value: top?.realized ?? 0,
      unit: "money",
      currency: top?.currency ?? report.totals[0]?.currency ?? "USD",
      from: window.from,
      to: window.to,
      ...(buckets.length > 1
        ? { note: `Savings in ${buckets.length} currencies; showing ${top?.currency}.` }
        : {}),
    };
  }
  const primary = primarySavingsTotal(report);
  return {
    value: primary?.realized ?? 0,
    unit: "money",
    currency: primary?.currency ?? "USD",
    from: window.from,
    to: window.to,
    note: joinNotes(
      report.totals.length > 1
        ? `Savings in ${report.totals.length} currencies; showing ${primary?.currency}.`
        : undefined,
      report.unmeasuredCount > 0
        ? `${report.unmeasuredCount} action(s) could not be measured and are not counted.`
        : undefined,
    ),
  };
}

/** Clamp a savings window to "through yesterday": today has no settled bill. */
function savingsWindow(range: { from: string; to: string }, now: Date) {
  const yesterday = dayBefore(iso(now));
  const to = range.to > yesterday ? yesterday : range.to;
  return { from: range.from > to ? to : range.from, to };
}

async function savingsKpi(
  organizationId: string,
  config: KpiWidgetConfig,
  eventKind: SavingsEventKind | undefined,
  now: Date,
): Promise<{ current: Measured; previous: Measured | null }> {
  const window = savingsWindow(
    resolveCostDateRange(config.dateRange ?? KPI_DEFAULT_DATE_RANGE, now),
    now,
  );
  const [current, previous] = await Promise.all([
    savingsTotal(organizationId, window, eventKind, now),
    config.comparePreviousPeriod
      ? savingsTotal(organizationId, previousEqualWindow(window.from, window.to), eventKind, now)
      : Promise.resolve(null),
  ]);
  return { current, previous };
}

/** Coverage (lower bound) or utilization, as the commitments feed reads them at `at`. */
async function commitmentReading(
  organizationId: string,
  measure: "coverage" | "utilization",
  at: Date,
): Promise<Measured> {
  const feed = await getCommitmentsFeed(organizationId, at);
  const to = iso(at);
  const from = addDays(to, -(feed.utilizationWindowDays - 1));
  if (measure === "coverage") {
    if (!feed.coverage.available || feed.coverage.currencies.length === 0) {
      return {
        value: null,
        unit: "percent",
        from,
        to,
        note: "Coverage is unavailable: no account reports which usage a commitment covered.",
      };
    }
    // The currency with the most consumption: ratios never mix currencies.
    const primary = [...feed.coverage.currencies].sort(
      (a, b) => b.coveredAmount + b.uncoveredAmount - (a.coveredAmount + a.uncoveredAmount),
    )[0]!;
    const broad = primary.broadRatio === null ? null : primary.broadRatio * 100;
    const narrow = primary.narrowRatio === null ? null : primary.narrowRatio * 100;
    return {
      value: broad,
      unit: "percent",
      from,
      to,
      note: joinNotes(
        narrow !== null && broad !== null && Math.round(narrow) !== Math.round(broad)
          ? `Between ${Math.round(broad)}% of all usage and ${Math.round(narrow)}% of commitment-eligible usage.`
          : undefined,
        feed.coverage.currencies.length > 1 ? `Measured in ${primary.currency}.` : undefined,
      ),
    };
  }
  // Utilization: delivered over obligation, summed across holdings that can
  // state an obligation in money, in the currency holding the most of it.
  const byCurrency = new Map<string, { delivered: number; obligation: number }>();
  for (const h of feed.holdings) {
    const u = h.utilization;
    if (u.obligationAmount === null || u.obligationAmount <= 0 || !h.currency) continue;
    const row = byCurrency.get(h.currency) ?? { delivered: 0, obligation: 0 };
    row.delivered += u.deliveredAmount;
    row.obligation += u.obligationAmount;
    byCurrency.set(h.currency, row);
  }
  const primary = [...byCurrency.entries()].sort((a, b) => b[1].obligation - a[1].obligation)[0];
  if (!primary) {
    return {
      value: null,
      unit: "percent",
      from,
      to,
      note: "No commitment states an obligation in money that utilization can be measured against.",
    };
  }
  return {
    value: (primary[1].delivered / primary[1].obligation) * 100,
    unit: "percent",
    from,
    to,
    ...(byCurrency.size > 1 ? { note: `Measured over ${primary[0]} commitments.` } : {}),
  };
}

async function commitmentsKpi(
  organizationId: string,
  config: KpiWidgetConfig,
  measure: "coverage" | "utilization",
  now: Date,
): Promise<{ current: Measured; previous: Measured | null }> {
  const current = await commitmentReading(organizationId, measure, now);
  if (!config.comparePreviousPeriod || !current.from) return { current, previous: null };
  const windowDays = inclusiveDayCount(current.from, current.to ?? current.from);
  const previous = await commitmentReading(
    organizationId,
    measure,
    new Date(now.getTime() - windowDays * DAY_MS),
  );
  return { current, previous };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Answer one KPI config.
 *
 * @throws {DashboardKpiError} for a config that cannot be answered (a deleted
 *   report, a report with no business metric, a role without budgets).
 */
export async function evaluateDashboardKpi(
  organizationId: string,
  config: KpiWidgetConfig,
  opts: DashboardKpiOptions,
): Promise<DashboardKpiResult> {
  const problem = kpiWidgetConfigProblem(config);
  if (problem) throw new DashboardKpiError(problem);
  const now = opts.now ?? new Date();
  const source = config.source;

  let measured: { current: Measured; previous: Measured | null };
  switch (source.kind) {
    case "cost_report":
      measured = await reportKpi(organizationId, config, source, now);
      break;
    case "budget":
      measured = await budgetKpi(organizationId, config, source, opts, now);
      break;
    case "commitments":
      measured =
        source.measure === "savings"
          ? await savingsKpi(organizationId, config, "commitment", now)
          : await commitmentsKpi(organizationId, config, source.measure, now);
      break;
    case "realized_savings":
      measured = await savingsKpi(organizationId, config, source.eventKind, now);
      break;
  }

  const { current, previous } = measured;
  // A comparison across currencies is not a change in anything.
  const comparable =
    previous !== null &&
    (current.unit !== "money" || !previous.currency || previous.currency === current.currency);
  const previousValue = comparable ? previous.value : null;
  const { change, changePercent } = kpiChange(current.value, previousValue);
  return {
    value: current.value,
    unit: current.unit,
    ...(current.currency ? { currency: current.currency } : {}),
    ...(current.perUnit ? { perUnit: current.perUnit } : {}),
    previous: previousValue,
    change,
    changePercent,
    upIsGood: kpiUpIsGood(config),
    ...(current.from ? { from: current.from } : {}),
    ...(current.to ? { to: current.to } : {}),
    ...(comparable && previous.from ? { previousFrom: previous.from } : {}),
    ...(comparable && previous.to ? { previousTo: previous.to } : {}),
    ...(current.sourceName ? { sourceName: current.sourceName } : {}),
    ...(current.limit !== undefined ? { limit: current.limit } : {}),
    ...(current.note ? { note: current.note } : {}),
  };
}
