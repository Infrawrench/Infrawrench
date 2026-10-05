/**
 * Budget threshold evaluation. Runs from the poller after each successful
 * cost collection for an org: org cost data only changes when collection
 * runs, so no separate scheduler is needed. The unique index on
 * budget_alert_events (budgetId, month, thresholdType, thresholdPercent)
 * makes each threshold fire at most once per budget period (`month` holds the
 * period key: "YYYY-MM" for a calendar-month budget, the period's start day
 * otherwise): `onConflictDoNothing` + RETURNING tells us whether this crossing
 * is fresh, and only fresh crossings notify.
 *
 * A budget measures one of two things over one window:
 *
 * - **what**: money (`measure = "cost"`, the default) or a usage quantity in one
 *   unit (`measure = "usage"`, summed from the cost rows' `usage_amount`);
 * - **when**: the calendar month (the default), a custom cadence, or an
 *   explicit list of periods; `resolveBudgetPeriod` in client-core picks the
 *   window containing today, so the server and every client agree on it.
 *
 * And it either measures its own scope (a leaf) or **rolls up** its children
 * (a parent): a parent's actual and forecast are the sums of its children's,
 * each child re-measured over the *parent's* window so a yearly parent over
 * monthly children still adds up a year. {@link BudgetStatusResolver} owns
 * that recursion and memoizes per (budget, window), so evaluating a whole org
 * measures each leaf at most once per distinct window.
 */
import { resolveObjectCostVisibility } from "./visibility";
import { runWithCostVisibility, type CostVisibility } from "./visibility-context";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  budgetLimitForWindow,
  resolveBudgetPeriod,
  type BudgetHierarchyWarning,
  type BudgetMeasure,
  type BudgetPeriod,
  type BudgetPeriodWindow,
  type BudgetThreshold,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { budgetAlertEvents, budgets } from "../db/schema";
import {
  queryCosts,
  queryUsageDaily,
  type CostBasis,
  type CostFilter,
} from "../clickhouse/cost-readers";
import { billingAdjustmentsAreEmpty } from "@infrawrench/client-core";
import { resolveBillingAdjustments } from "./billing-rules";
import { convertGroups } from "./currency-convert";
import { getOrgCurrencySettings, listOrgExchangeRates } from "./currency-settings";
import {
  forecastDaily,
  forecastWindowTotal,
  remainingDaysInWindow,
  type DailyPoint,
} from "./forecast";
import { resolveSavedCostFilters } from "./saved-filters";
import { forecastWithScenario, resolveCostScenarioModel } from "./scenario-forecast";
import { sendBudgetAlertPage } from "../twilio-pager";
import { alertReached, routeAlert } from "../alerts/route";
import {
  fireBudgetTriggerWorkflows,
  listBudgetTriggerWorkflows,
} from "../workflows/budget-triggers";
import { isoDay, addDays } from "./dates";
import { orgAppUrl } from "../app-url";

type BudgetRow = typeof budgets.$inferSelect;

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function formatUsage(value: number, unit: string): string {
  const text = new Intl.NumberFormat("en-US", {
    notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1,
  }).format(value);
  return `${text} ${unit}`;
}

/** What a leaf budget's scope is, independent of the window it is read over. */
interface BudgetScope {
  filters: CostFilter[];
  currency: string;
  costBasis?: CostBasis | undefined;
  savedFilterId?: string | null | undefined;
  scenarioModelId?: string | null | undefined;
  useAdjustedSpend?: boolean | undefined;
}

/**
 * One scope read over one window, in **major units** (currency units for
 * money, the raw quantity for usage). Cents happen once, at the edge.
 */
interface ScopeMeasurement {
  actual: number;
  /** Collected spend; set only when billing rules were applied. */
  rawActual: number | null;
  adjustedSpend: boolean;
  /** The unadjusted trend forecast for the window. */
  forecast: number | null;
  /** The scenario-adjusted forecast; set only for a scope that opted in. */
  scenarioForecast: number | null;
  scenarioModelName: string | null;
  unconvertedCurrencies: string[];
  converted: boolean;
}

/**
 * Current-month actual + forecast for a budget's scope, in its currency.
 * Fit data spans the trailing 60 days so early-month forecasts still have a
 * full window. Kept for callers that think in calendar months; budgets with
 * configurable periods go through {@link BudgetStatusResolver}, which reads
 * the same scope over whatever window the budget covers.
 *
 * `costBasis` is the budget's own, defaulting to cash. It has to be threaded
 * all the way down here rather than applied afterwards: the forecast is fit on
 * these same daily points, and fitting a trend through a cash series that
 * contains one enormous commitment purchase projects a month-end total that
 * will never happen.
 *
 * ## The budget currency vs. the org display currency
 *
 * A budget already has its own `currency`, and **that does not change.** It is
 * the unit of `amountCents`, of every threshold comparison, and of every alert
 * message. The org's display currency does not override it and cannot
 * re-denominate a budget somebody set.
 *
 * What the display currency does is narrower, and deliberately so. A budget
 * counts only spend already in its own currency and silently discards the
 * rest, so a USD budget in an org that also bills in EUR tracks a number that
 * is not the org's spend. When (and only when) **the budget's currency is the
 * org's display currency**, the other currencies' spend is converted into it
 * first, using the org's own stated rates.
 *
 * Why gate it on that equality rather than converting into any budget's
 * currency: rates are stated *to* the display currency in one hop, and nothing
 * inverts or chains them. There are simply no rates pointing at a GBP budget in
 * a USD-display org, so "convert into the budget's currency" would have no
 * rates to use. Gating on the equality makes the rule honest instead of
 * sometimes-working.
 *
 * The consequence worth stating plainly: an org that has not set a display
 * currency, or whose budget is in some other currency, gets byte-identical
 * behaviour to before, including the old drop-other-currencies behaviour.
 * Enabling conversion can only ever make a budget count *more* spend, never
 * less, so it cannot silently un-fire an alert that would have fired.
 *
 * `unconvertedCurrencies` names the currencies that were dropped anyway
 * because the org holds no rate for them. A budget is a single number and
 * cannot carry a second currency alongside it, so this is the one place a
 * currency really is excluded from a total, and it is reported rather than
 * hidden, so the budget card can say the figure is short.
 */
/*
 * ## Scenario models and budget thresholds
 *
 * `scenarioModelId` is **opt-in per budget, and null by default.** With it null
 * (which is every budget that existed before scenarios, and every budget
 * nobody deliberately opts in) this returns exactly what it always returned,
 * and `forecastCents` is the bare trend.
 *
 * That default is a deliberate refusal, not an oversight. A scenario model is a
 * hypothesis somebody typed into a form; budget forecast thresholds decide when
 * a real person is paged. Letting the first silently move the second would mean
 * anyone with `costs:write` could change an on-call rota by editing an object
 * two screens away, and the page (or the missing page) would carry no evidence
 * of why.
 *
 * When a budget *does* opt in, three things keep it visible: `forecastCents`
 * stays the unadjusted trend so both numbers can be shown side by side, the
 * adjusted figure comes back separately as `scenarioForecastCents`, and the
 * model's name is carried out so the card and the alert body can name it.
 * `actual` thresholds are never affected: they measure money already spent,
 * which no scenario can touch.
 *
 * ## Billing rules and budget thresholds
 *
 * `useAdjustedSpend` is the same refusal, and it follows the same precedent:
 * **false by default, opt-in per budget.** With it false (every budget that
 * existed before billing rules, and every budget nobody deliberately opts in)
 * the rules table is never read and the result is exactly what it always was.
 *
 * The reason is sharper than the scenario one. A markup is org policy that
 * changes every number the org reports; a budget threshold decides when a real
 * person is paged. If a markup silently raised measured spend, adding one
 * settings row would move every on-call rota in the org at once, and every
 * resulting page would be for money nobody actually spent.
 *
 * Unlike a scenario this affects `actual` thresholds too, and must: an opted-in
 * budget is measuring the *internal* figure, and period-to-date internal spend
 * is as marked up as the forecast is. Judging actual on collected spend and
 * forecast on adjusted spend would be a budget measuring two different things.
 * `rawActualCents` comes back beside it so the card and the alert can always
 * show what was collected.
 */
export async function budgetMonthStatus(
  organizationId: string,
  filters: CostFilter[],
  currency: string,
  now = new Date(),
  costBasis?: CostBasis,
  savedFilterId?: string | null,
  scenarioModelId?: string | null,
  useAdjustedSpend?: boolean,
): Promise<{
  month: string;
  actualCents: number;
  /**
   * Month-to-date **collected** spend, set only for a budget measuring adjusted
   * spend. Null otherwise, where `actualCents` already is the collected figure.
   */
  rawActualCents: number | null;
  /** True when every figure here has the org's billing rules applied. */
  adjustedSpend: boolean;
  /** The **unadjusted trend** forecast, whether or not a scenario is applied. */
  forecastCents: number | null;
  /**
   * The scenario-adjusted month forecast, set only when this budget opted into
   * a model. Null means forecast thresholds are judged on `forecastCents`.
   */
  scenarioForecastCents: number | null;
  /** The opted-into model's name, for the card and the alert body. */
  scenarioModelName: string | null;
  /** Currencies present in scope that could not be converted, so were excluded. */
  unconvertedCurrencies: string[];
  /** True when spend in other currencies was folded in at the org's rates. */
  converted: boolean;
}> {
  const today = isoDay(now);
  const window = resolveBudgetPeriod(null, today)!;
  const m = await measureCostScope(
    organizationId,
    { filters, currency, costBasis, savedFilterId, scenarioModelId, useAdjustedSpend },
    window,
    today,
  );
  return { month: window.key, ...costFigures(m) };
}

/** A cost measurement's major-unit figures as the cents the API speaks. */
function costFigures(m: ScopeMeasurement) {
  return {
    actualCents: Math.round(m.actual * 100),
    // Null rather than a copy of `actualCents` for an un-opted budget: "there
    // is no separate collected figure because this one is it" and "the
    // collected figure happens to equal the adjusted one" are different facts,
    // and a card that showed "(collected $X)" under every budget in the org
    // would make the ones that really are adjusted invisible.
    rawActualCents: m.rawActual === null ? null : Math.round(m.rawActual * 100),
    adjustedSpend: m.adjustedSpend,
    forecastCents: m.forecast === null ? null : Math.round(m.forecast * 100),
    scenarioForecastCents:
      m.scenarioForecast === null ? null : Math.round(m.scenarioForecast * 100),
    scenarioModelName: m.scenarioModelName,
    unconvertedCurrencies: m.unconvertedCurrencies,
    converted: m.converted,
  };
}

/**
 * The first day the trailing data has to cover: the window's start, or 59 days
 * back when that is earlier, so a forecast early in a short period still has a
 * full fit window behind it.
 */
function fetchFrom(window: BudgetPeriodWindow, today: string): string {
  const fitStart = addDays(today, -59);
  return window.start < fitStart ? window.start : fitStart;
}

function lastObservedDay(window: BudgetPeriodWindow, today: string): string {
  return window.end < today ? window.end : today;
}

/** One spend scope over one window: the body of every money budget. */
async function measureCostScope(
  organizationId: string,
  scope: BudgetScope,
  window: BudgetPeriodWindow,
  today: string,
): Promise<ScopeMeasurement> {
  const { currency, costBasis, savedFilterId, scenarioModelId, useAdjustedSpend } = scope;
  // A saved filter is resolved here, at evaluation time, so an edit to it
  // re-scopes the budget on the next pass. A reference that fails to resolve
  // throws: the caller must surface the failure, because evaluating this
  // budget over unfiltered spend would fire or suppress alerts it should not.
  const effectiveFilters = savedFilterId
    ? [...(await resolveSavedCostFilters(organizationId, savedFilterId)), ...scope.filters]
    : scope.filters;

  // Read only for a budget that opted in: an un-opted budget never touches the
  // rules table, so a markup cannot reach a threshold it was not invited to.
  const billing = useAdjustedSpend ? await resolveBillingAdjustments(organizationId) : null;
  const adjustments =
    billing && !billingAdjustmentsAreEmpty(billing.adjustments) ? billing.adjustments : undefined;

  const to = lastObservedDay(window, today);
  const groups = await queryCosts(organizationId, {
    from: fetchFrom(window, today),
    to,
    binning: "daily",
    groupBy: "none",
    filters: effectiveFilters,
    ...(costBasis ? { costBasis } : {}),
    ...(adjustments ? { adjustments } : {}),
  });

  // Conversion is attempted only when the budget is denominated in the org's
  // display currency: see the doc comment on budgetMonthStatus.
  const settings = await getOrgCurrencySettings(organizationId).catch(() => ({
    displayCurrency: null as string | null,
  }));
  const target = settings.displayCurrency === currency ? currency : null;
  const rates = target ? await listOrgExchangeRates(organizationId) : [];
  const { groups: usable, conversion } = convertGroups(groups, target, rates);

  const daily = new Map<string, number>();
  // The collected series rides along from the same scan, converted through the
  // same rates, so "adjusted $12,400 (collected $10,800)" is two readings of
  // one pass rather than two queries that could disagree.
  const rawDaily = new Map<string, number>();
  for (const g of usable) {
    if (g.currency !== currency) continue;
    for (const p of g.points) daily.set(p.bucket, (daily.get(p.bucket) ?? 0) + p.amount);
    for (const p of g.rawPoints ?? []) {
      rawDaily.set(p.bucket, (rawDaily.get(p.bucket) ?? 0) + p.amount);
    }
  }
  const points = toDailyPoints(daily);
  const inWindow = (day: string) => day >= window.start && day <= window.end;
  const windowPoints = points.filter((p) => inWindow(p.day));
  const actual = windowPoints.reduce((sum, p) => sum + p.amount, 0);
  const rawActual = [...rawDaily.entries()]
    .filter(([day]) => inWindow(day))
    .reduce((sum, [, amount]) => sum + amount, 0);
  const forecast = forecastWindowTotal(points, window.start, window.end);

  // The scenario overlay, computed *in addition to* the trend above and never
  // in place of it. Nothing below runs for a budget that did not opt in, so an
  // un-opted budget's numbers are byte-identical to what they have always been.
  let scenarioForecast: number | null = null;
  let scenarioModelName: string | null = null;
  if (scenarioModelId) {
    // Throws out to the caller when the model no longer resolves: the budget's
    // evaluation is skipped and logged rather than quietly falling back to the
    // trend, which would change which thresholds fire with no evidence at all.
    const model = await resolveCostScenarioModel(organizationId, scenarioModelId);
    scenarioModelName = model.name;
    const remaining = remainingDaysInWindow(windowPoints, window.end);
    const baseline = remaining > 0 ? windowBaselineProjection(points, windowPoints, remaining) : [];
    if (baseline.length === 0) {
      // Nothing left to project (the period is over, or there is no history to
      // fit): the adjusted figure is the trend figure, by construction.
      scenarioForecast = forecast;
    } else {
      const projection = await forecastWithScenario({
        organizationId,
        model,
        baseline,
        filters: effectiveFilters,
        fitTo: to,
        ...(costBasis ? { costBasis } : {}),
        baselineCurrency: currency,
        displayCurrency: target,
        rates,
      });
      const projected = projection.points.reduce((sum, p) => sum + p.amount, 0);
      scenarioForecast = actual + projected;
    }
  }

  return {
    actual,
    rawActual: adjustments ? rawActual : null,
    adjustedSpend: Boolean(useAdjustedSpend),
    forecast,
    scenarioForecast,
    scenarioModelName,
    // Currencies with no rate are excluded from the figure above, so name them.
    // Without conversion on, every other currency was always excluded and
    // saying so would be new noise about long-standing behaviour, hence the
    // empty list rather than "all of them".
    unconvertedCurrencies: conversion?.unconverted ?? [],
    converted: (conversion?.converted.length ?? 0) > 0,
  };
}

/**
 * One usage scope over one window: the cost rows' usage quantity in one unit.
 * No currency, no cost basis, no billing rules and no scenario: those all
 * adjust money, which is why `budgetInputError` refuses them on a usage budget.
 */
async function measureUsageScope(
  organizationId: string,
  scope: BudgetScope & { usageUnit: string },
  window: BudgetPeriodWindow,
  today: string,
): Promise<ScopeMeasurement> {
  const effectiveFilters = scope.savedFilterId
    ? [...(await resolveSavedCostFilters(organizationId, scope.savedFilterId)), ...scope.filters]
    : scope.filters;
  const series = await queryUsageDaily(organizationId, {
    from: fetchFrom(window, today),
    to: lastObservedDay(window, today),
    filters: effectiveFilters,
    usageUnit: scope.usageUnit,
  });
  const daily = new Map<string, number>();
  for (const p of series) daily.set(p.bucket, (daily.get(p.bucket) ?? 0) + p.amount);
  const points = toDailyPoints(daily);
  const actual = points
    .filter((p) => p.day >= window.start && p.day <= window.end)
    .reduce((sum, p) => sum + p.amount, 0);
  return {
    actual,
    rawActual: null,
    adjustedSpend: false,
    forecast: forecastWindowTotal(points, window.start, window.end),
    scenarioForecast: null,
    scenarioModelName: null,
    unconvertedCurrencies: [],
    converted: false,
  };
}

function toDailyPoints(daily: Map<string, number>): DailyPoint[] {
  return [...daily.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, amount]) => ({ day, amount }));
}

/**
 * The trend projection for the rest of the window, in the same shape a chart's
 * forecast has.
 *
 * Mirrors `forecastWindowTotal` exactly (the fit first, the period-to-date
 * daily average as the fallback) so that a scenario with no adjustments active
 * would reproduce the trend figure rather than a differently-derived one.
 * Nothing would be more confusing on a budget card than two "forecasts" that
 * disagree before any assumption has been applied.
 */
function windowBaselineProjection(
  points: DailyPoint[],
  windowPoints: DailyPoint[],
  remaining: number,
): DailyPoint[] {
  const projected = forecastDaily(points, remaining);
  if (projected.length > 0) return projected;

  if (windowPoints.length === 0) return [];
  const toDate = windowPoints.reduce((sum, p) => sum + p.amount, 0);
  const dailyAvg = toDate / windowPoints.length;
  const lastDay = windowPoints[windowPoints.length - 1]!.day;
  return Array.from({ length: remaining }, (_, i) => ({
    day: addDays(lastDay, i + 1),
    amount: dailyAvg,
  }));
}

/** Sum children's measurements of one window into their parent's. */
function sumMeasurements(parts: ScopeMeasurement[]): ScopeMeasurement {
  const anyForecast = parts.some((p) => p.forecast !== null);
  const anyScenario = parts.some((p) => p.scenarioForecast !== null);
  const anyRaw = parts.some((p) => p.rawActual !== null);
  const names = [...new Set(parts.map((p) => p.scenarioModelName).filter((n) => n !== null))];
  return {
    actual: parts.reduce((s, p) => s + p.actual, 0),
    // A child with no separate collected figure contributes its actual, which
    // *is* its collected figure: see `costFigures`.
    rawActual: anyRaw ? parts.reduce((s, p) => s + (p.rawActual ?? p.actual), 0) : null,
    adjustedSpend: parts.some((p) => p.adjustedSpend),
    // A child with no data in the window has no forecast and has spent
    // nothing, so it adds its actual (0) rather than making the sum unknown.
    forecast: anyForecast ? parts.reduce((s, p) => s + (p.forecast ?? p.actual), 0) : null,
    scenarioForecast: anyScenario
      ? parts.reduce((s, p) => s + (p.scenarioForecast ?? p.forecast ?? p.actual), 0)
      : null,
    scenarioModelName: names.length > 0 ? names.join(", ") : null,
    unconvertedCurrencies: [...new Set(parts.flatMap((p) => p.unconvertedCurrencies))],
    converted: parts.some((p) => p.converted),
  };
}

/** Everything a budget's status says about its current period. */
export interface BudgetPeriodStatus {
  measure: BudgetMeasure;
  /** "YYYY-MM" of the period start (today's month when no period is active). */
  month: string;
  /** Dedupe key for alert events; null when no period covers today. */
  periodKey: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** This period's limit in the budget's unit (cents, or the usage quantity). */
  limit: number | null;
  actualCents: number;
  rawActualCents: number | null;
  adjustedSpend: boolean;
  forecastCents: number | null;
  scenarioForecastCents: number | null;
  scenarioModelName: string | null;
  unconvertedCurrencies: string[];
  converted: boolean;
  actualUsage: number | null;
  forecastUsage: number | null;
  /** True when the figures are the sum of child budgets. */
  rolledUp: boolean;
  childCount: number;
  hierarchyWarnings: BudgetHierarchyWarning[];
}

function budgetMeasure(row: BudgetRow): BudgetMeasure {
  return row.measure === "usage" ? "usage" : "cost";
}

function budgetPeriod(row: BudgetRow): BudgetPeriod | null {
  return (row.period ?? null) as BudgetPeriod | null;
}

/**
 * Computes budget statuses for one org at one instant, rolling parents up from
 * their children. Construct it over the org's whole (non-deleted) budget list:
 * a parent can only be summed from children it can see.
 *
 * Throws out of {@link status} exactly when a leaf's own measurement would (a
 * saved filter or scenario that no longer resolves), so a parent over a broken
 * child fails loudly rather than reporting a total silently short of that
 * child's spend.
 */
export class BudgetStatusResolver {
  private readonly byId: Map<string, BudgetRow>;
  private readonly childrenOf = new Map<string, BudgetRow[]>();
  private readonly memo = new Map<string, Promise<ScopeMeasurement>>();
  readonly today: string;

  constructor(
    private readonly organizationId: string,
    rows: BudgetRow[],
    now = new Date(),
  ) {
    this.today = isoDay(now);
    this.byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      if (!r.parentBudgetId || r.parentBudgetId === r.id || !this.byId.has(r.parentBudgetId)) {
        continue;
      }
      const list = this.childrenOf.get(r.parentBudgetId) ?? [];
      list.push(r);
      this.childrenOf.set(r.parentBudgetId, list);
    }
  }

  children(budgetId: string): BudgetRow[] {
    return this.childrenOf.get(budgetId) ?? [];
  }

  /** The window `row` is currently measured over, or null when none covers today. */
  window(row: BudgetRow): BudgetPeriodWindow | null {
    return resolveBudgetPeriod(budgetPeriod(row), this.today);
  }

  /** `row` read over `window`: its own scope, or the sum of its children's. */
  private measure(
    row: BudgetRow,
    window: BudgetPeriodWindow,
    path: Set<string> = new Set(),
  ): Promise<ScopeMeasurement> {
    const key = `${row.id}\x00${window.start}\x00${window.end}`;
    const cached = this.memo.get(key);
    if (cached) return cached;
    const children = this.children(row.id).filter((c) => !path.has(c.id));
    let pending: Promise<ScopeMeasurement>;
    if (children.length > 0) {
      const nextPath = new Set(path).add(row.id);
      pending = Promise.all(children.map((c) => this.measure(c, window, nextPath))).then(
        sumMeasurements,
      );
    } else {
      const scope: BudgetScope = {
        filters: (row.filters ?? []) as CostFilter[],
        currency: row.currency,
        costBasis: (row.costBasis ?? undefined) as CostBasis | undefined,
        savedFilterId: row.savedFilterId,
        scenarioModelId: row.scenarioModelId,
        useAdjustedSpend: row.useAdjustedSpend,
      };
      pending =
        budgetMeasure(row) === "usage"
          ? measureUsageScope(
              this.organizationId,
              { ...scope, usageUnit: row.usageUnit ?? "" },
              window,
              this.today,
            )
          : measureCostScope(this.organizationId, scope, window, this.today);
    }
    this.memo.set(key, pending);
    // A failed read must not be served from the memo to the next caller as if
    // it were an answer; drop it so a retry re-measures.
    pending.catch(() => this.memo.delete(key));
    return pending;
  }

  async status(budgetId: string): Promise<BudgetPeriodStatus> {
    const row = this.byId.get(budgetId);
    if (!row) throw new Error(`budget ${budgetId} is not in this resolver`);
    const measure = budgetMeasure(row);
    const children = this.children(row.id);
    const window = this.window(row);
    const empty: BudgetPeriodStatus = {
      measure,
      month: this.today.slice(0, 7),
      periodKey: null,
      periodStart: null,
      periodEnd: null,
      limit: null,
      actualCents: 0,
      rawActualCents: null,
      adjustedSpend: Boolean(row.useAdjustedSpend) && measure === "cost",
      forecastCents: null,
      scenarioForecastCents: null,
      scenarioModelName: null,
      unconvertedCurrencies: [],
      converted: false,
      actualUsage: measure === "usage" ? 0 : null,
      forecastUsage: null,
      rolledUp: children.length > 0,
      childCount: children.length,
      hierarchyWarnings: [],
    };
    if (!window) return empty;

    const m = await this.measure(row, window);
    const limit = budgetLimitForWindow(
      { measure, amountCents: row.amountCents, usageAmount: row.usageAmount },
      window,
    );
    const status: BudgetPeriodStatus = {
      ...empty,
      month: window.start.slice(0, 7),
      periodKey: window.key,
      periodStart: window.start,
      periodEnd: window.end,
      limit,
      ...(measure === "cost"
        ? costFigures(m)
        : { actualUsage: m.actual, forecastUsage: m.forecast }),
    };
    if (children.length > 0 && limit !== null) {
      status.hierarchyWarnings = this.hierarchyWarnings(children, window, limit, status);
    }
    return status;
  }

  /** Where `children` outgrow a parent whose limit is `limit` over `window`. */
  private hierarchyWarnings(
    children: BudgetRow[],
    window: BudgetPeriodWindow,
    limit: number,
    status: BudgetPeriodStatus,
  ): BudgetHierarchyWarning[] {
    const warnings: BudgetHierarchyWarning[] = [];
    // Only children on the very same window are comparable: a monthly child's
    // amount says nothing about how much of a quarterly parent it claims.
    let allocated = 0;
    let comparable = 0;
    for (const child of children) {
      const childWindow = this.window(child);
      if (!childWindow || childWindow.start !== window.start || childWindow.end !== window.end) {
        continue;
      }
      const childLimit = budgetLimitForWindow(
        {
          measure: budgetMeasure(child),
          amountCents: child.amountCents,
          usageAmount: child.usageAmount,
        },
        childWindow,
      );
      if (childLimit === null) continue;
      allocated += childLimit;
      comparable += 1;
    }
    if (comparable > 0 && allocated > limit) {
      warnings.push({ kind: "allocation", childTotal: allocated, parentLimit: limit });
    }
    const actual = status.measure === "usage" ? (status.actualUsage ?? 0) : status.actualCents;
    if (actual > limit) warnings.push({ kind: "actual", childTotal: actual, parentLimit: limit });
    const forecast =
      status.measure === "usage"
        ? status.forecastUsage
        : (status.scenarioForecastCents ?? status.forecastCents);
    if (forecast !== null && forecast > limit) {
      warnings.push({ kind: "forecast", childTotal: forecast, parentLimit: limit });
    }
    return warnings;
  }
}

/** "for 2026-07", or "for 2026-10-05 to 2026-10-18" for a custom period. */
function periodPhrase(status: BudgetPeriodStatus): string {
  if (status.periodKey && /^\d{4}-\d{2}$/.test(status.periodKey)) return status.periodKey;
  if (status.periodStart === status.periodEnd) return status.periodStart ?? "";
  return `${status.periodStart} to ${status.periodEnd}`;
}

/**
 * Evaluate every budget in an org: fire alert pages for freshly crossed
 * thresholds, and run any workflows triggered by this budget. Errors are
 * logged, never thrown: budget evaluation must not break the poller's cost
 * pass.
 */
export async function evaluateBudgetsForOrg(
  organizationId: string,
  now = new Date(),
): Promise<void> {
  let rows: BudgetRow[];
  try {
    rows = await db
      .select()
      .from(budgets)
      .where(and(eq(budgets.organizationId, organizationId), isNull(budgets.deletedAt)));
  } catch (err) {
    console.error("[budget-eval] failed to load budgets for org", organizationId, err);
    return;
  }

  // Loaded once for the org, not per budget. A budget with no alert thresholds
  // still needs its status computed when a workflow watches it.
  const triggerWorkflows = await listBudgetTriggerWorkflows(organizationId);
  // One resolver per visibility owner (`visibility_user_id`, null = org-wide),
  // built over the budgets that owner can see and measured inside their scope,
  // so a scoped member's parent never sums a budget they cannot read, and
  // within one owner a parent and its children share leaf reads. The memo is
  // per resolver, so a figure measured in one scope is never served in another.
  const owners = new Map<
    string | null,
    Promise<{ resolver: BudgetStatusResolver; visibility: CostVisibility }>
  >();
  const ownerContext = (owner: string | null) => {
    let ctx = owners.get(owner);
    if (!ctx) {
      ctx = resolveObjectCostVisibility(organizationId, owner).then((visibility) => ({
        visibility,
        resolver: new BudgetStatusResolver(
          organizationId,
          owner === null ? rows : rows.filter((r) => r.visibilityUserId === owner),
          now,
        ),
      }));
      owners.set(owner, ctx);
    }
    return ctx;
  };

  for (const budget of rows) {
    try {
      const thresholds = (budget.thresholds ?? []) as BudgetThreshold[];
      const watchers = triggerWorkflows.filter(
        (w) => (w.trigger as { budgetId?: string } | null)?.budgetId === budget.id,
      );
      if (thresholds.length === 0 && watchers.length === 0) continue;
      const measure = budgetMeasure(budget);
      // No period covering today, or no positive amount for it: nothing can
      // cross, and no query needs to run to find that out.
      const { resolver, visibility } = await ownerContext(budget.visibilityUserId ?? null);
      const window = resolver.window(budget);
      if (
        !window ||
        budgetLimitForWindow(
          { measure, amountCents: budget.amountCents, usageAmount: budget.usageAmount },
          window,
        ) === null
      ) {
        continue;
      }

      // A budget referencing a saved filter that no longer resolves throws
      // out of the resolver into this budget's catch below: the evaluation is
      // skipped and logged, never silently run over all spend.
      // A budget a cost-scoped member created measures only the spend that
      // member can see (`budgets.visibility_user_id`, resolved live), so its
      // alerts cannot carry totals the creator could not read directly.
      const status = await runWithCostVisibility(visibility, () => resolver.status(budget.id));
      const limit = status.limit;
      if (limit === null || status.periodKey === null) continue;
      const usage = measure === "usage";
      const unit = budget.usageUnit ?? "";
      const fmt = (value: number) =>
        usage ? formatUsage(value, unit) : formatCents(value, budget.currency);

      if (watchers.length > 0) {
        await fireBudgetTriggerWorkflows({
          organizationId,
          budget: {
            id: budget.id,
            name: budget.name,
            amountCents: budget.amountCents,
            currency: budget.currency,
            measure,
            usageUnit: budget.usageUnit,
          },
          status: {
            month: status.periodKey,
            actualCents: status.actualCents,
            forecastCents: status.forecastCents,
            limit,
            actualUsage: status.actualUsage,
            forecastUsage: status.forecastUsage,
            periodStart: status.periodStart,
            periodEnd: status.periodEnd,
          },
          candidates: watchers,
        });
      }

      for (const threshold of thresholds) {
        const limitValue = usage
          ? (limit * threshold.percent) / 100
          : Math.round((limit * threshold.percent) / 100);
        // `actual` is money (or usage) already recorded, which no scenario can
        // touch. `forecast` uses the adjusted figure **only** for a budget
        // that opted into a model (or a parent over a child that did):
        // `scenarioForecastCents` is null for every other one, so this reads
        // as the bare trend exactly as it always did.
        const observed = usage
          ? threshold.type === "actual"
            ? (status.actualUsage ?? 0)
            : (status.forecastUsage ?? 0)
          : threshold.type === "actual"
            ? status.actualCents
            : (status.scenarioForecastCents ?? status.forecastCents ?? 0);
        if (observed < limitValue || observed === 0) continue;

        const [inserted] = await db
          .insert(budgetAlertEvents)
          .values({
            id: randomUUID(),
            budgetId: budget.id,
            organizationId,
            month: status.periodKey,
            thresholdType: threshold.type,
            thresholdPercent: threshold.percent,
            actualAmountCents: usage ? 0 : status.actualCents,
            forecastAmountCents: usage ? null : status.forecastCents,
            periodStart: status.periodStart,
            periodEnd: status.periodEnd,
            actualUsage: usage ? status.actualUsage : null,
            forecastUsage: usage ? status.forecastUsage : null,
          })
          .onConflictDoNothing()
          .returning({ id: budgetAlertEvents.id });
        if (!inserted) continue; // already fired this period

        const kind = usage
          ? threshold.type === "actual"
            ? "usage"
            : "forecasted usage"
          : threshold.type === "actual"
            ? "spend"
            : "forecasted spend";
        // A converted figure has to say so in the message itself. The alert is
        // often the only place this number is ever read, and a total that
        // quietly folded in three currencies at rates somebody set months ago
        // is not a number to page on without the caveat attached.
        const caveats = [
          // A parent's figure is somebody else's spend added up: say whose.
          ...(status.rolledUp
            ? [`sum of ${status.childCount} child budget${status.childCount === 1 ? "" : "s"}`]
            : []),
          // A threshold crossed on a scenario-adjusted number must say whose
          // assumptions moved it. This is often the only place the figure is
          // ever read, and "why was I paged" has to be answerable from the
          // message itself.
          ...(threshold.type === "forecast" && status.scenarioModelName
            ? [`includes scenario "${status.scenarioModelName}"`]
            : []),
          // A page fired on a marked-up number must say so, and say what was
          // actually collected. Without this the recipient is looking at money
          // the organisation charged itself and has no way to tell.
          ...(status.adjustedSpend
            ? [
                status.rawActualCents === null
                  ? "billing rules applied"
                  : `billing rules applied — collected spend ${formatCents(status.rawActualCents, budget.currency)}`,
              ]
            : []),
          ...(status.converted
            ? ["converted to the org display currency at your stated rates"]
            : []),
          ...(status.unconvertedCurrencies.length > 0
            ? [`excludes spend in ${status.unconvertedCurrencies.join(", ")} — no rate configured`]
            : []),
        ];
        const suffix = caveats.length > 0 ? ` (${caveats.join("; ")})` : "";
        const period = periodPhrase(status);
        const alertBody = `infrawrench budget "${budget.name}": ${kind} ${fmt(observed)} has reached ${threshold.percent}% of ${fmt(limit)} for ${period}${suffix}`;
        const paged = await sendBudgetAlertPage(organizationId, alertBody);
        // Routing is independent of the org's Twilio settings: dedupe already
        // happened via the budget_alert_events insert above.
        const url = orgAppUrl(organizationId, `budgets/${budget.id}`);
        const routed = await routeAlert({
          costVisibilityUserId: budget.visibilityUserId ?? null,
          organizationId,
          trigger: "budgetAlerts",
          // A budget at or past 100% is a different kind of news from one at
          // 80%, and severity is what a quiet-hours `urgentOverride` keys on,
          // so "sleep through warnings, wake me if we actually blew the budget"
          // is expressible without a second rule.
          severity: threshold.percent >= 100 ? "critical" : "warning",
          title: `Budget "${budget.name}" at ${threshold.percent}%`,
          body: alertBody,
          context: `${period} · ${kind}`,
          url,
          pushData: {
            type: "budget_breach",
            orgId: organizationId,
            budgetId: budget.id,
            month: status.periodKey,
            thresholdPercent: threshold.percent,
          },
          // Money facts only for money: an "over $500" routing rule must not
          // match a usage budget because it crossed 50,000 tokens.
          facts: usage
            ? { key: budget.name }
            : { amountCents: observed, currency: budget.currency, key: budget.name },
        });
        if (paged || alertReached(routed)) {
          await db
            .update(budgetAlertEvents)
            .set({ notifiedAt: new Date() })
            .where(eq(budgetAlertEvents.id, inserted.id));
        }
      }
    } catch (err) {
      console.error(`[budget-eval] budget ${budget.id} evaluation failed:`, err);
    }
  }
}
