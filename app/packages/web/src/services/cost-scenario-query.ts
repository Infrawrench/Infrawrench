/**
 * The scenario half of `runCostQuery`, kept out of that function on purpose.
 *
 * By the time this runs the response is complete: the series are aggregated,
 * the currencies are resolved, and `response.forecast` holds the trend
 * projection. All that is left is to load the named model and overlay it — so
 * that is all this module does, and `runCostQuery` grows one `if`.
 *
 * The one decision made here rather than downstream is **what currency the
 * projection is in**, because only this layer can see it: a response carries a
 * `currencies` list and possibly a conversion, and a scenario's amounts are
 * only addable when there is exactly one number to add them to.
 */
import type {
  CostBasis,
  CostChargeType,
  CostFilter,
  CostScenarioProjection,
  CostSeriesPoint,
  ExchangeRate,
} from "@infrawrench/client-core";
import {
  CostScenarioApplicationError,
  CostScenarioResolutionError,
  forecastWithScenario,
  resolveCostScenarioModel,
} from "@infrawrench/server-core/cost/scenario-forecast";

/**
 * Anything that stops a scenario being applied, in one class the caller can
 * map to a 400. Both underlying failures are the caller's problem to fix — a
 * deleted model, or a currency the org has stated no rate for — and neither is
 * ever recoverable by quietly returning an unadjusted projection.
 */
export class CostScenarioError extends Error {
  override readonly name = "CostScenarioError";
}

export interface AttachCostScenarioOptions {
  organizationId: string;
  scenarioModelId: string;
  /** The trend projection, or undefined when there was too little history. */
  forecast: CostSeriesPoint[] | undefined;
  /** The chart's resolved filters (saved filter and text query included). */
  filters: CostFilter[];
  /** The query's range end — where the sub-scope fits end too. */
  fitTo: string;
  costBasis?: CostBasis | undefined;
  chargeTypes?: CostChargeType[] | undefined;
  /** Distinct currencies in the response's series. */
  currencies: string[];
  displayCurrency: string | null;
  rates: ExchangeRate[];
}

/**
 * Apply a scenario model to a response's forecast.
 *
 * Returns undefined when there is no forecast to adjust — an org with fewer
 * than a week of data gets no projection at all, and a scenario line hanging in
 * space with no trend beside it would be a claim about the future built on
 * nothing. That is not an error; there is simply nothing to draw.
 *
 * @throws {CostScenarioError} when the model does not resolve, or its amounts
 * cannot be expressed in the projection's currency.
 */
export async function attachCostScenario(
  options: AttachCostScenarioOptions,
): Promise<CostScenarioProjection | undefined> {
  const forecast = options.forecast;
  if (!forecast || forecast.length === 0) return undefined;

  try {
    const model = await resolveCostScenarioModel(options.organizationId, options.scenarioModelId);
    return await forecastWithScenario({
      organizationId: options.organizationId,
      model,
      baseline: forecast.map((p) => ({ day: p.bucket, amount: p.amount })),
      filters: options.filters,
      fitTo: options.fitTo,
      ...(options.costBasis ? { costBasis: options.costBasis } : {}),
      ...(options.chargeTypes ? { chargeTypes: options.chargeTypes } : {}),
      // The currency the projection is denominated in. Conversion wins when it
      // is on (every series was folded into the display currency); otherwise a
      // single-currency org has one, and a mixed one has none — which makes any
      // model carrying an amount unapplicable, loudly, rather than adding
      // dollars to a sum of dollars and euros.
      baselineCurrency: options.currencies.length === 1 ? (options.currencies[0] ?? null) : null,
      displayCurrency: options.displayCurrency,
      rates: options.rates,
    });
  } catch (e) {
    if (e instanceof CostScenarioResolutionError || e instanceof CostScenarioApplicationError) {
      throw new CostScenarioError(e.message);
    }
    throw e;
  }
}
