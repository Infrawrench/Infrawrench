/**
 * Named forecasts on a cost report, and the confidence band every forecast
 * carries.
 *
 * The automatic forecast is a least-squares trend over the report's trailing
 * daily spend (`server-core/cost/forecast.ts`). A **custom forecast** is a
 * named recipe on top of it, saved on one report:
 *
 * 1. a **baseline**: the trend, or, when a driver business metric is set,
 *    "projected unit cost times the metric's forecasted values", so a plan
 *    that says "twice the customers in March" moves the line;
 * 2. zero or more **scenario models**, applied in priority order. Each model
 *    is applied to the line the previous ones produced, which is the only
 *    place order shows: an org-wide percentage in a later model also scales
 *    the amounts an earlier one added. (Inside one model the existing rule is
 *    unchanged: rate changes are deltas against the untouched trend and their
 *    order cannot matter.)
 *
 * The band is the trend's prediction interval (or the driver's, see below),
 * carried through every scenario as a shift: scenario adjustments are things
 * somebody says they know, so they move the band without widening it.
 *
 * One forecast per report can be the **default**: it is what the report's
 * Forecasts view opens on, what `POST /cost-reports/{id}/forecasted-costs`
 * returns when no forecast is named, and what the CLI prints. A report with no
 * default falls back to the automatic forecast.
 *
 * Types live here rather than in `@infrawrench/ui` because mobile reads them
 * too; `ui/src/cost/config.ts` holds the zod schema and proves at compile time
 * that it parses to exactly these shapes.
 */

import { CloudApiError, type CloudFetch } from "./fetch";
import type { CostScenarioContribution } from "./cost-scenarios";

/* ------------------------------------------------------------------ *
 * Confidence levels.
 * ------------------------------------------------------------------ */

/**
 * Two-sided confidence levels a forecast band can be drawn at, in percent.
 * Mirrors `FORECAST_CONFIDENCE_LEVELS` in server-core, which tabulates the t
 * quantiles behind them.
 */
export const COST_FORECAST_CONFIDENCE_LEVELS = [80, 90, 95] as const;
export type CostForecastConfidenceLevel = (typeof COST_FORECAST_CONFIDENCE_LEVELS)[number];
export const DEFAULT_COST_FORECAST_CONFIDENCE_LEVEL: CostForecastConfidenceLevel = 80;

/** Whether `value` is a supported confidence level. */
export function isCostForecastConfidenceLevel(
  value: unknown,
): value is CostForecastConfidenceLevel {
  return (COST_FORECAST_CONFIDENCE_LEVELS as readonly unknown[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * The saved object.
 * ------------------------------------------------------------------ */

export const COST_FORECAST_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 500,
  /** Named forecasts on one report. */
  maxPerReport: 20,
  /** Scenario models one forecast stacks. */
  maxScenarioModels: 10,
  /** Furthest `to` the forecasted-costs read projects to, in days. */
  maxHorizonDays: 366,
  /** Horizon when the request names no `to`. */
  defaultHorizonDays: 90,
} as const;

/** Create/update payload (POST/PUT /cost-reports/{id}/forecasts). */
export interface CostForecastInput {
  name: string;
  description?: string | null | undefined;
  /** Scenario models to apply, in priority order (first applied first). */
  scenarioModelIds: string[];
  /**
   * A business metric whose forecasted values drive the baseline (projected
   * unit cost times forecast volume); null keeps the trend.
   */
  driverMetricId?: string | null | undefined;
  /** Make this the report's default forecast (clears any other default). */
  isDefault?: boolean | undefined;
}

/** A named forecast as returned by the API. */
export interface CostForecast {
  id: string;
  reportId: string;
  name: string;
  description: string | null;
  scenarioModelIds: string[];
  driverMetricId: string | null;
  isDefault: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_COST_FORECAST_INPUT: CostForecastInput = {
  name: "",
  description: null,
  scenarioModelIds: [],
  driverMetricId: null,
  isDefault: false,
};

/**
 * The one validation of a forecast, run by the editors and by the service on
 * every write. Null when valid. Whether the referenced models and metric exist
 * is the service's question; this only checks the shape.
 */
export function costForecastInputError(input: CostForecastInput): string | null {
  const name = input.name?.trim() ?? "";
  if (!name) return "A forecast needs a name.";
  if (name.length > COST_FORECAST_LIMITS.maxNameLength) {
    return `Name must be ${COST_FORECAST_LIMITS.maxNameLength} characters or fewer.`;
  }
  if ((input.description?.length ?? 0) > COST_FORECAST_LIMITS.maxDescriptionLength) {
    return `Description must be ${COST_FORECAST_LIMITS.maxDescriptionLength} characters or fewer.`;
  }
  const ids = input.scenarioModelIds ?? [];
  if (ids.length > COST_FORECAST_LIMITS.maxScenarioModels) {
    return `A forecast can stack at most ${COST_FORECAST_LIMITS.maxScenarioModels} scenario models.`;
  }
  if (ids.some((id) => typeof id !== "string" || id.trim() === "")) {
    return "Every scenario model reference needs an id.";
  }
  if (new Set(ids).size !== ids.length) {
    return "A scenario model can only appear once in a forecast.";
  }
  if (ids.length === 0 && !input.driverMetricId) {
    return (
      "Add a scenario model or a driver metric. Without either the forecast is the automatic " +
      "one, which every report already has."
    );
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * The forecasted-costs read.
 * ------------------------------------------------------------------ */

/** One projected day. Bounds are null when there was no fit to take them from. */
export interface CostForecastPoint {
  day: string;
  expected: number;
  low: number | null;
  high: number | null;
}

/** A projected total over the horizon, with its interval. */
export interface CostForecastTotal {
  expected: number;
  low: number | null;
  high: number | null;
}

/** What the driver metric did to the baseline. */
export interface CostForecastDriverSummary {
  metricId: string;
  metricName: string;
  metricUnit: string;
  /**
   * Projected spend per unit, averaged over the horizon's driven days, in the
   * forecast's currency. Null when no day had a forecasted value.
   */
  unitCost: number | null;
  /** Sum of the metric's forecasted values over the horizon. */
  metricTotal: number;
  /** Horizon days that had a forecasted metric value. */
  coveredDays: number;
  totalDays: number;
}

/** One scenario model's part in a forecast, in application order. */
export interface CostForecastScenarioSummary {
  modelId: string;
  modelName: string;
  /** Signed change this model made to the running line across the horizon. */
  totalDelta: number;
  contributions: CostScenarioContribution[];
  outOfScope: string[];
}

/** One line on the comparison: the automatic forecast or a named one. */
export interface CostForecastSeries {
  /** Null for the automatic (trend) forecast. */
  forecastId: string | null;
  name: string;
  isDefault: boolean;
  points: CostForecastPoint[];
  total: CostForecastTotal;
  /** `total.expected` minus the automatic forecast's. 0 for the baseline itself. */
  deltaFromBaseline: number;
  scenarios: CostForecastScenarioSummary[];
  driver: CostForecastDriverSummary | null;
  /** Things a reader should know about this line (missing driver values, ...). */
  warnings: string[];
}

/** Request body for `POST /cost-reports/{id}/forecasted-costs`. */
export interface CostForecastRunRequest {
  /** First projected day; defaults to the day after the last observed one. */
  from?: string | undefined;
  /** Last projected day; defaults to 90 days after the last observed one. */
  to?: string | undefined;
  /**
   * The forecast to return: a forecast id, `"baseline"` for the automatic one,
   * or absent for the report's default (the automatic one when none is set).
   */
  forecastId?: string | undefined;
  /** Narrow to these providers (plugin ids), ANDed with the report's filters. */
  providers?: string[] | undefined;
  /** Narrow to these services, ANDed with the report's filters. */
  services?: string[] | undefined;
  /** Band level in percent; defaults to 80. */
  confidenceLevel?: CostForecastConfidenceLevel | undefined;
  /** Also return every named forecast, for the side-by-side view. */
  all?: boolean | undefined;
}

/** Response of `POST /cost-reports/{id}/forecasted-costs`. */
export interface CostForecastResult {
  reportId: string;
  reportName: string;
  /** The projected window actually returned (inclusive YYYY-MM-DD). */
  from: string;
  to: string;
  /** Last day with observed spend the fit used; null with no history. */
  lastObservedDay: string | null;
  /** Currency of every amount; null when the report sums several. */
  currency: string | null;
  confidenceLevel: CostForecastConfidenceLevel;
  /** The automatic forecast, always. */
  baseline: CostForecastSeries;
  /** The requested forecast, or the default; the baseline when neither exists. */
  forecast: CostForecastSeries;
  /** Every named forecast, in list order; set only when `all` was asked for. */
  forecasts?: CostForecastSeries[] | undefined;
}

/* ------------------------------------------------------------------ *
 * Pure helpers shared by the server and the views.
 * ------------------------------------------------------------------ */

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Re-centre a band on an adjusted line: each day's bounds move by exactly as
 * much as its expected value did, clamped at zero. Used to carry the trend's
 * interval through scenario models, which shift the line without adding
 * uncertainty of their own.
 */
export function shiftForecastBand(
  start: readonly CostForecastPoint[],
  adjusted: ReadonlyMap<string, number>,
): CostForecastPoint[] {
  return start.map((p) => {
    const next = adjusted.get(p.day);
    if (next === undefined) return { ...p };
    const delta = next - p.expected;
    return {
      day: p.day,
      expected: round6(next),
      low: p.low === null ? null : round6(Math.max(0, p.low + delta)),
      high: p.high === null ? null : round6(Math.max(0, p.high + delta)),
    };
  });
}

/** Move a total's interval by `delta` (the sum of the scenario shifts). */
export function shiftForecastTotal(total: CostForecastTotal, delta: number): CostForecastTotal {
  return {
    expected: round6(Math.max(0, total.expected + delta)),
    low: total.low === null ? null : round6(Math.max(0, total.low + delta)),
    high: total.high === null ? null : round6(Math.max(0, total.high + delta)),
  };
}

/**
 * A total by summing daily points. The expected value is exact; summing the
 * daily bounds over-states the interval (it treats every day's error as moving
 * together), so the server only uses this where it has no fit to compute the
 * total's own interval from.
 */
export function sumForecastPoints(points: readonly CostForecastPoint[]): CostForecastTotal {
  let expected = 0;
  let low: number | null = 0;
  let high: number | null = 0;
  for (const p of points) {
    expected += p.expected;
    low = low === null || p.low === null ? null : low + p.low;
    high = high === null || p.high === null ? null : high + p.high;
  }
  return {
    expected: round6(expected),
    low: low === null ? null : round6(low),
    high: high === null ? null : round6(high),
  };
}

/** Whether a total carries a usable interval. */
export function hasForecastBand(
  total: CostForecastTotal,
): total is CostForecastTotal & { low: number; high: number } {
  return total.low !== null && total.high !== null;
}

/**
 * Comparison rows for the side-by-side view: the automatic forecast first,
 * then every named one with its difference from it.
 */
export function costForecastComparisonRows(
  result: CostForecastResult,
): Array<CostForecastSeries & { isBaseline: boolean }> {
  const named = result.forecasts ?? (result.forecast.forecastId ? [result.forecast] : []);
  return [
    { ...result.baseline, isBaseline: true },
    ...named.map((s) => ({ ...s, isBaseline: false })),
  ];
}

/**
 * Which forecast a report shows first: the default one, else the automatic
 * forecast (null).
 */
export function defaultCostForecastId(forecasts: readonly CostForecast[]): string | null {
  return forecasts.find((f) => f.isDefault)?.id ?? null;
}

/* ------------------------------------------------------------------ *
 * Fetch helpers: used by mobile (web and desktop go through their own
 * transports, like the rest of the cost surface).
 * ------------------------------------------------------------------ */

/** A report's named forecasts (`GET /cost-reports/{id}/forecasts`). */
export async function listCostForecasts(
  api: CloudFetch,
  orgId: string,
  reportId: string,
): Promise<CostForecast[]> {
  const res = await api.org<{ forecasts: CostForecast[] }>(
    orgId,
    `/cost-reports/${encodeURIComponent(reportId)}/forecasts`,
  );
  return res?.forecasts ?? [];
}

/**
 * Run a report's forecast (`POST /cost-reports/{id}/forecasted-costs`). Null
 * when the report does not exist (or is not shared with the caller).
 */
export async function runCostForecast(
  api: CloudFetch,
  orgId: string,
  reportId: string,
  request: CostForecastRunRequest = {},
): Promise<CostForecastResult | null> {
  try {
    return await api.org<CostForecastResult>(
      orgId,
      `/cost-reports/${encodeURIComponent(reportId)}/forecasted-costs`,
      { method: "POST", body: JSON.stringify(request) },
    );
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 404) return null;
    throw error;
  }
}
