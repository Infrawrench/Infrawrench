/**
 * Named forecasts on a cost report: CRUD, and the forecasted-costs read that
 * runs them. Shared by the HTTP routes and the MCP tool, like every other
 * cost service. The contract (and why scenarios apply in order and the band
 * shifts rather than widens) is `client-core/src/cost-forecasts.ts`.
 *
 * Access follows the report: listing and running need the report to be
 * visible to the caller (sharing), writing needs editor on it. Cost visibility
 * scopes need nothing here: every spend read goes through `queryCosts`, whose
 * org predicate carries the caller's scope ambiently.
 */
import { and, asc, eq, max, ne, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import {
  COST_FORECAST_LIMITS,
  DEFAULT_COST_FORECAST_CONFIDENCE_LEVEL,
  costForecastInputError,
  shiftForecastBand,
  shiftForecastTotal,
  type CostBasis,
  type CostChargeType,
  type CostFilter,
  type CostForecast,
  type CostForecastConfidenceLevel,
  type CostForecastInput,
  type CostForecastPoint,
  type CostForecastResult,
  type CostForecastRunRequest,
  type CostForecastScenarioSummary,
  type CostForecastSeries,
  type CostForecastTotal,
} from "@infrawrench/client-core";
import { costQueryForConfig } from "@infrawrench/ui/cost/config";
import { addDays, daysBetween, isoDay } from "@infrawrench/server-core/cost/dates";
import {
  driverBaseline,
  inSlice,
  trendBaseline,
  type ForecastBaseline,
  type ForecastHorizon,
} from "@infrawrench/server-core/cost/report-forecast";
import {
  CostScenarioApplicationError,
  CostScenarioResolutionError,
  forecastWithScenario,
  resolveCostScenarioModel,
} from "@infrawrench/server-core/cost/scenario-forecast";
import {
  getOrgCurrencySettings,
  loadConversionContext,
} from "@infrawrench/server-core/cost/currency-settings";
import { resolveBillingAdjustments } from "@infrawrench/server-core/cost/billing-rules";
import { getMetricValues } from "@infrawrench/server-core/cost/metric-ingest";
import type { RateSource } from "@infrawrench/server-core/cost/currency-convert";
import type { DailyPoint } from "@infrawrench/server-core/cost/forecast";

import { db } from "../db/client";
import { costReportForecasts } from "../db/schema";
import { getBusinessMetric } from "./business-metrics";
import { getBusinessMetricForecastMap } from "./business-metric-forecast-values";
import { loadAccessibleCostReport } from "./cost-reports";
import { CostQueryError, loadForecastObservations, resolveCostRequestFilters } from "./cost-query";

/** Anything the caller can fix: a 400 at the API. */
export class CostForecastError extends Error {
  override readonly name = "CostForecastError";
}

/** A name another forecast on the same report already has: a 409. */
export class CostForecastNameConflictError extends Error {
  override readonly name = "CostForecastNameConflictError";
  constructor(name: string) {
    super(`This report already has a forecast named "${name}".`);
  }
}

type ForecastRow = typeof costReportForecasts.$inferSelect;

function toCostForecast(row: ForecastRow): CostForecast {
  return {
    id: row.id,
    reportId: row.costReportId,
    name: row.name,
    description: row.description,
    scenarioModelIds: (row.scenarioModelIds ?? []) as string[],
    driverMetricId: row.driverMetricId,
    isDefault: row.isDefault,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505"
  );
}

async function forecastRows(organizationId: string, reportId: string): Promise<ForecastRow[]> {
  return db
    .select()
    .from(costReportForecasts)
    .where(
      and(
        eq(costReportForecasts.organizationId, organizationId),
        eq(costReportForecasts.costReportId, reportId),
      ),
    )
    .orderBy(asc(costReportForecasts.position), asc(costReportForecasts.createdAt));
}

/** A report's named forecasts in list order. Null when the report is not visible. */
export async function listCostForecasts(
  organizationId: string,
  reportId: string,
): Promise<CostForecast[] | null> {
  const report = await loadAccessibleCostReport(organizationId, reportId);
  if (!report) return null;
  return (await forecastRows(organizationId, reportId)).map(toCostForecast);
}

/**
 * Check a forecast's references resolve now, so a typo is a 400 at save time
 * rather than a broken Forecasts view later. The run re-checks (a model can be
 * deleted afterwards only if this forecast stops naming it, see the scenario
 * referent scan; a metric is soft-deleted freely and the run says so).
 */
async function assertReferencesResolve(
  organizationId: string,
  input: CostForecastInput,
): Promise<void> {
  for (const modelId of input.scenarioModelIds) {
    try {
      await resolveCostScenarioModel(organizationId, modelId);
    } catch (e) {
      if (e instanceof CostScenarioResolutionError) {
        throw new CostForecastError(
          `Scenario model ${modelId} does not exist in this organization.`,
        );
      }
      throw e;
    }
  }
  if (input.driverMetricId) {
    const metric = await getBusinessMetric(organizationId, input.driverMetricId);
    if (!metric) {
      throw new CostForecastError(
        `Business metric ${input.driverMetricId} does not exist in this organization.`,
      );
    }
  }
}

function normalizeInput(input: CostForecastInput): CostForecastInput {
  const problem = costForecastInputError(input);
  if (problem) throw new CostForecastError(problem);
  return {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    scenarioModelIds: [...input.scenarioModelIds],
    driverMetricId: input.driverMetricId || null,
    ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
  };
}

/** Create a forecast on a report. Null when the report is not visible. */
export async function createCostForecast(
  organizationId: string,
  reportId: string,
  rawInput: CostForecastInput,
  createdByUserId: string | null,
): Promise<CostForecast | null> {
  const report = await loadAccessibleCostReport(organizationId, reportId, "editor");
  if (!report) return null;
  const input = normalizeInput(rawInput);
  await assertReferencesResolve(organizationId, input);

  try {
    return await db.transaction(async (tx) => {
      const [{ count, last } = { count: 0, last: null }] = await tx
        .select({
          count: sql<number>`count(*)::int`,
          last: max(costReportForecasts.position),
        })
        .from(costReportForecasts)
        .where(
          and(
            eq(costReportForecasts.organizationId, organizationId),
            eq(costReportForecasts.costReportId, reportId),
          ),
        );
      if (Number(count) >= COST_FORECAST_LIMITS.maxPerReport) {
        throw new CostForecastError(
          `A report can hold at most ${COST_FORECAST_LIMITS.maxPerReport} forecasts.`,
        );
      }
      if (input.isDefault) await clearDefault(tx, organizationId, reportId, null);
      const [row] = await tx
        .insert(costReportForecasts)
        .values({
          id: uuidv4(),
          organizationId,
          costReportId: reportId,
          name: input.name,
          description: input.description ?? null,
          scenarioModelIds: input.scenarioModelIds,
          driverMetricId: input.driverMetricId ?? null,
          isDefault: Boolean(input.isDefault),
          position: (last ?? -1) + 1,
          createdByUserId,
        })
        .returning();
      return toCostForecast(row!);
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new CostForecastNameConflictError(input.name);
    throw e;
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function clearDefault(
  tx: Tx,
  organizationId: string,
  reportId: string,
  exceptId: string | null,
): Promise<void> {
  await tx
    .update(costReportForecasts)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(
      and(
        eq(costReportForecasts.organizationId, organizationId),
        eq(costReportForecasts.costReportId, reportId),
        eq(costReportForecasts.isDefault, true),
        exceptId ? ne(costReportForecasts.id, exceptId) : undefined,
      ),
    );
}

/**
 * Replace a forecast's definition. `isDefault` absent keeps the current
 * setting, so an editor that does not show the toggle cannot clear it; true
 * makes it the default (clearing any other), false makes the report fall back
 * to the automatic forecast if this one was the default. Null when not found.
 */
export async function updateCostForecast(
  organizationId: string,
  reportId: string,
  forecastId: string,
  rawInput: CostForecastInput,
): Promise<CostForecast | null> {
  const report = await loadAccessibleCostReport(organizationId, reportId, "editor");
  if (!report) return null;
  const input = normalizeInput(rawInput);
  await assertReferencesResolve(organizationId, input);

  try {
    return await db.transaction(async (tx) => {
      if (input.isDefault) await clearDefault(tx, organizationId, reportId, forecastId);
      const [row] = await tx
        .update(costReportForecasts)
        .set({
          name: input.name,
          description: input.description ?? null,
          scenarioModelIds: input.scenarioModelIds,
          driverMetricId: input.driverMetricId ?? null,
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(costReportForecasts.id, forecastId),
            eq(costReportForecasts.organizationId, organizationId),
            eq(costReportForecasts.costReportId, reportId),
          ),
        )
        .returning();
      return row ? toCostForecast(row) : null;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new CostForecastNameConflictError(input.name);
    throw e;
  }
}

/** Hard-delete a forecast. False when not found. */
export async function deleteCostForecast(
  organizationId: string,
  reportId: string,
  forecastId: string,
): Promise<{ deleted: boolean; name: string | null }> {
  const report = await loadAccessibleCostReport(organizationId, reportId, "editor");
  if (!report) return { deleted: false, name: null };
  const [row] = await db
    .delete(costReportForecasts)
    .where(
      and(
        eq(costReportForecasts.id, forecastId),
        eq(costReportForecasts.organizationId, organizationId),
        eq(costReportForecasts.costReportId, reportId),
      ),
    )
    .returning({ name: costReportForecasts.name });
  return { deleted: Boolean(row), name: row?.name ?? null };
}

/* ------------------------------------------------------------------ *
 * The forecasted-costs read.
 * ------------------------------------------------------------------ */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Everything a series needs that every series shares. */
interface RunContext {
  organizationId: string;
  horizon: ForecastHorizon;
  observed: DailyPoint[];
  trend: ForecastBaseline | null;
  filters: CostFilter[];
  fitTo: string;
  costBasis?: CostBasis | undefined;
  chargeTypes?: CostChargeType[] | undefined;
  currency: string | null;
  displayCurrency: string | null;
  rates: RateSource;
}

function slicePoints(points: CostForecastPoint[], h: ForecastHorizon): CostForecastPoint[] {
  return points.filter((p) => inSlice(h, p.day));
}

const EMPTY_TOTAL: CostForecastTotal = { expected: 0, low: null, high: null };

function baselineSeries(ctx: RunContext): CostForecastSeries {
  return {
    forecastId: null,
    name: "Automatic forecast",
    isDefault: false,
    points: ctx.trend ? slicePoints(ctx.trend.points, ctx.horizon) : [],
    total: ctx.trend ? ctx.trend.sliceTotal : EMPTY_TOTAL,
    deltaFromBaseline: 0,
    scenarios: [],
    driver: null,
    warnings: ctx.trend
      ? []
      : [
          "Not enough history to forecast: the trend needs at least 7 days of spend in the last 60.",
        ],
  };
}

async function namedSeries(ctx: RunContext, forecast: CostForecast): Promise<CostForecastSeries> {
  const base = baselineSeries(ctx);
  const series: CostForecastSeries = {
    ...base,
    forecastId: forecast.id,
    name: forecast.name,
    isDefault: forecast.isDefault,
    warnings: [...base.warnings],
  };
  if (!ctx.trend) return series;

  // 1. The baseline: the trend, or the driver metric's projection.
  let start: ForecastBaseline = ctx.trend;
  if (forecast.driverMetricId) {
    const metric = await getBusinessMetric(ctx.organizationId, forecast.driverMetricId);
    if (!metric) {
      throw new CostForecastError(
        `Forecast "${forecast.name}" is driven by a business metric that no longer exists. ` +
          "Pick another driver metric or remove it; the forecast will not fall back to the trend " +
          "on its own.",
      );
    }
    const [actuals, planned] = await Promise.all([
      getMetricValues(metric.id, ctx.observed[0]?.day ?? ctx.horizon.lastObserved, ctx.fitTo),
      getBusinessMetricForecastMap(metric.id, addDays(ctx.horizon.lastObserved, 1), ctx.horizon.to),
    ]);
    const driven = driverBaseline({
      observed: ctx.observed,
      metricActuals: new Map(actuals.map((v) => [v.day, v.value])),
      metricForecast: planned,
      trend: ctx.trend,
      h: ctx.horizon,
    });
    if (!driven.ok) {
      series.warnings.push(`${driven.reason} The trend is shown instead.`);
    } else {
      start = driven.baseline;
      series.driver = {
        metricId: metric.id,
        metricName: metric.name,
        metricUnit: metric.unit,
        unitCost: driven.unitCost,
        metricTotal: driven.metricTotal,
        coveredDays: driven.coveredDays,
        totalDays: driven.totalDays,
      };
      if (driven.coveredDays === 0) {
        series.warnings.push(
          `${metric.name} has no forecasted values in this window, so every day uses the trend. ` +
            "Add forecasted values to the metric (Costs → Unit costs → Values).",
        );
      } else if (driven.coveredDays < driven.totalDays) {
        series.warnings.push(
          `${driven.totalDays - driven.coveredDays} of ${driven.totalDays} days have no ` +
            `forecasted ${metric.name} value; those days use the trend.`,
        );
      }
    }
  }

  // 2. Scenario models, in priority order, each applied to the line the
  // previous ones produced. The band is shifted, not widened.
  let running = start.points;
  let sliceDelta = 0;
  const scenarios: CostForecastScenarioSummary[] = [];
  for (const modelId of forecast.scenarioModelIds) {
    let projection;
    try {
      const model = await resolveCostScenarioModel(ctx.organizationId, modelId);
      projection = await forecastWithScenario({
        organizationId: ctx.organizationId,
        model,
        baseline: running.map((p) => ({ day: p.day, amount: p.expected })),
        filters: ctx.filters,
        fitTo: ctx.fitTo,
        ...(ctx.costBasis ? { costBasis: ctx.costBasis } : {}),
        ...(ctx.chargeTypes && ctx.chargeTypes.length > 0 ? { chargeTypes: ctx.chargeTypes } : {}),
        baselineCurrency: ctx.currency,
        displayCurrency: ctx.displayCurrency,
        rates: ctx.rates,
      });
    } catch (e) {
      if (e instanceof CostScenarioResolutionError || e instanceof CostScenarioApplicationError) {
        throw new CostForecastError(`Forecast "${forecast.name}": ${e.message}`);
      }
      throw e;
    }
    const adjusted = new Map(projection.points.map((p) => [p.bucket, p.amount]));
    const before = new Map(running.map((p) => [p.day, p.expected]));
    let modelDelta = 0;
    for (const [day, amount] of adjusted) {
      if (inSlice(ctx.horizon, day)) modelDelta += amount - (before.get(day) ?? 0);
    }
    sliceDelta += modelDelta;
    running = shiftForecastBand(running, adjusted);
    scenarios.push({
      modelId: projection.modelId,
      modelName: projection.modelName,
      totalDelta: Math.round(modelDelta * 1e6) / 1e6,
      contributions: projection.contributions,
      outOfScope: projection.outOfScope,
    });
  }

  series.points = slicePoints(running, ctx.horizon);
  series.total = shiftForecastTotal(start.sliceTotal, sliceDelta);
  series.scenarios = scenarios;
  series.deltaFromBaseline =
    Math.round((series.total.expected - ctx.trend.sliceTotal.expected) * 1e6) / 1e6;
  return series;
}

/**
 * Run a report's forecasts: the automatic one always, the requested (or
 * default) one, and every named one when `all` is set. Null when the report is
 * not visible to the caller.
 *
 * The fit always ends today, whatever window the report itself draws: a
 * report on "last month" still forecasts forward from the newest spend.
 */
export async function runCostReportForecast(
  organizationId: string,
  reportId: string,
  request: CostForecastRunRequest,
  today = new Date(),
): Promise<CostForecastResult | null> {
  const report = await loadAccessibleCostReport(organizationId, reportId);
  if (!report) return null;

  const config = report.config;
  if (config.measure && config.measure !== "cost") {
    throw new CostForecastError(
      "Forecasts project spend, and this report measures " +
        `${config.measure === "usage" ? "usage" : "a count"}. Switch the report to cost to forecast it.`,
    );
  }
  for (const [key, value] of [
    ["from", request.from],
    ["to", request.to],
  ] as const) {
    if (value !== undefined && !ISO_DAY.test(value)) {
      throw new CostForecastError(`${key} must be YYYY-MM-DD`);
    }
  }
  const level: CostForecastConfidenceLevel =
    request.confidenceLevel ?? DEFAULT_COST_FORECAST_CONFIDENCE_LEVEL;

  const query = costQueryForConfig(config, today);
  let filters: CostFilter[];
  try {
    filters = [...(await resolveCostRequestFilters(organizationId, query))];
  } catch (e) {
    if (e instanceof CostQueryError) throw new CostForecastError(e.message);
    throw e;
  }
  if (request.providers && request.providers.length > 0) {
    filters.push({ dimension: "provider", op: "in", values: request.providers });
  }
  if (request.services && request.services.length > 0) {
    filters.push({ dimension: "service", op: "in", values: request.services });
  }

  // One number per day needs one currency: the org's display currency when it
  // has one (forecasts always convert), else whatever single currency the
  // scope spends in.
  const settings = await getOrgCurrencySettings(organizationId);
  const { displayCurrency, rates } = await loadConversionContext(
    organizationId,
    settings.displayCurrency ?? undefined,
  );
  const adjustments = query.adjusted
    ? (await resolveBillingAdjustments(organizationId)).adjustments
    : undefined;
  const fitTo = isoDay(today);
  const { observed, currencies } = await loadForecastObservations(organizationId, {
    filters,
    fitTo,
    ...(query.costBasis ? { costBasis: query.costBasis } : {}),
    ...(adjustments ? { adjustments } : {}),
    ...(query.chargeTypes ? { chargeTypes: query.chargeTypes } : {}),
    displayCurrency,
    rates,
  });
  const lastObserved = observed[observed.length - 1]?.day ?? null;
  const anchor = lastObserved ?? fitTo;
  const firstProjected = addDays(anchor, 1);
  const from = request.from && request.from > firstProjected ? request.from : firstProjected;
  const to = request.to ?? addDays(anchor, COST_FORECAST_LIMITS.defaultHorizonDays);
  if (to < from) {
    throw new CostForecastError(
      `to must be on or after ${from}, the first day there is no observed spend for.`,
    );
  }
  if (daysBetween(anchor, to) > COST_FORECAST_LIMITS.maxHorizonDays) {
    throw new CostForecastError(
      `Forecasts reach at most ${COST_FORECAST_LIMITS.maxHorizonDays} days past the last observed day (${anchor}).`,
    );
  }

  const horizon: ForecastHorizon = { lastObserved: anchor, to, sliceFrom: from, level };
  const ctx: RunContext = {
    organizationId,
    horizon,
    observed,
    trend: lastObserved ? trendBaseline(observed, horizon) : null,
    filters,
    fitTo,
    ...(query.costBasis ? { costBasis: query.costBasis } : {}),
    ...(query.chargeTypes ? { chargeTypes: query.chargeTypes } : {}),
    currency: displayCurrency ?? (currencies.length === 1 ? (currencies[0] ?? null) : null),
    displayCurrency,
    rates,
  };

  const rows = (await forecastRows(organizationId, reportId)).map(toCostForecast);
  let selected: CostForecast | null;
  if (request.forecastId === "baseline") selected = null;
  else if (request.forecastId) {
    selected = rows.find((f) => f.id === request.forecastId) ?? null;
    if (!selected)
      throw new CostForecastError(`This report has no forecast ${request.forecastId}.`);
  } else selected = rows.find((f) => f.isDefault) ?? null;

  const baseline = baselineSeries(ctx);
  const all = request.all ? await Promise.all(rows.map((f) => namedSeries(ctx, f))) : undefined;
  const forecast = selected
    ? (all?.find((s) => s.forecastId === selected.id) ?? (await namedSeries(ctx, selected)))
    : baseline;

  return {
    reportId: report.id,
    reportName: report.name,
    from,
    to,
    lastObservedDay: lastObserved,
    currency: ctx.currency,
    confidenceLevel: level,
    baseline,
    forecast,
    ...(all ? { forecasts: all } : {}),
  };
}
