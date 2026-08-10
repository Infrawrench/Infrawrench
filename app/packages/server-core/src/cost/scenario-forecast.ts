/**
 * Query-time resolution and application of a scenario model.
 *
 * Lives in server-core, not the web package, because the two consumers span
 * both: `runCostQuery` (web — the HTTP API, the MCP tools and therefore the
 * CLI) and `budgetMonthStatus` (here — also driven by the poller's budget
 * evaluation pass). One implementation is what keeps a chart's scenario line
 * and a budget's scenario-adjusted threshold from ever disagreeing about what
 * the same model means.
 *
 * The arithmetic itself is in `@infrawrench/client-core`
 * (`applyCostScenario`) and is pure. This module is the part that needs the
 * world: it loads the model, fetches one trend projection per distinct
 * adjustment scope from ClickHouse, and resolves the currency the amounts are
 * added in.
 *
 * ## Three rules it enforces
 *
 * 1. **A reference that fails to resolve is an error, never "no scenario".**
 *    Same stance as saved filters, and for the same reason from the other
 *    direction: a chart labelled "Scenario: Q4 plan" that quietly contains no
 *    plan is worse than a chart that refuses to draw.
 * 2. **History is untouched.** Only the days the caller hands over — which are
 *    by construction the projected ones — are ever adjusted.
 * 3. **Currencies are never silently mixed.** A model's amounts are added only
 *    when the projection is denominated in the model's own currency, or when
 *    the org has stated a rate that converts them into it. Otherwise the
 *    application fails loudly.
 */
import { and, eq, isNull } from "drizzle-orm";

import {
  applyCostScenario,
  costScenarioScopeKey,
  type CostScenarioAdjustment,
  type CostScenarioModel,
  type CostScenarioProjection,
  type ExchangeRate,
  type ScenarioDayPoint,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { costScenarioModels } from "../db/schema";
import {
  queryCosts,
  type CostBasis,
  type CostChargeType,
  type CostFilter,
} from "../clickhouse/cost-readers";
import { convertGroups } from "./currency-convert";
import { forecastDaily, type DailyPoint } from "./forecast";
import { addDays } from "./dates";

/** A `scenarioModelId` that does not resolve to a live model in the org. */
export class CostScenarioResolutionError extends Error {
  override readonly name = "CostScenarioResolutionError";
  readonly scenarioModelId: string;

  constructor(scenarioModelId: string) {
    super(
      `Scenario model ${scenarioModelId} not found — it may have been deleted. ` +
        "Refusing to project without it: a chart labelled with a scenario that silently " +
        "contains none is worse than one that does not draw.",
    );
    this.scenarioModelId = scenarioModelId;
  }
}

/** A model that cannot be applied to this projection — currency, mostly. */
export class CostScenarioApplicationError extends Error {
  override readonly name = "CostScenarioApplicationError";
}

type CostScenarioModelRow = typeof costScenarioModels.$inferSelect;

/** Assemble the wire shape from a stored row. */
export function toCostScenarioModel(row: CostScenarioModelRow): CostScenarioModel {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    currency: row.currency,
    adjustments: (row.adjustments ?? []) as CostScenarioAdjustment[],
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The model stored under `scenarioModelId`.
 *
 * @throws {CostScenarioResolutionError} when the id does not name a live model
 * in this org.
 */
export async function resolveCostScenarioModel(
  organizationId: string,
  scenarioModelId: string,
): Promise<CostScenarioModel> {
  const [row] = await db
    .select()
    .from(costScenarioModels)
    .where(
      and(
        eq(costScenarioModels.id, scenarioModelId),
        eq(costScenarioModels.organizationId, organizationId),
        isNull(costScenarioModels.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new CostScenarioResolutionError(scenarioModelId);
  return toCostScenarioModel(row);
}

/** How far back the sub-scope fits look, matching the main forecast's window. */
const FIT_WINDOW_DAYS = 60;

export interface ScenarioForecastOptions {
  organizationId: string;
  model: CostScenarioModel;
  /**
   * The unadjusted trend projection the caller already computed — the exact
   * days the scenario may touch, and no others.
   */
  baseline: ScenarioDayPoint[];
  /** The chart's own filters, already resolved (saved filters included). */
  filters: CostFilter[];
  /** Last day of observed data; sub-scope fits end here, as the main one does. */
  fitTo: string;
  costBasis?: CostBasis | undefined;
  chargeTypes?: CostChargeType[] | undefined;
  /**
   * The currency the baseline amounts are in, or null when the projection sums
   * more than one currency and the org has not chosen a display currency. Null
   * makes any model carrying an amount unapplicable — see below.
   */
  baselineCurrency: string | null;
  /** The org's display currency, when conversion is active. */
  displayCurrency: string | null;
  /** The org's stated rates, for converting the model's amounts. */
  rates: ExchangeRate[];
}

/**
 * Project `baseline` with `model` applied.
 *
 * @throws {CostScenarioApplicationError} when the model's amounts cannot be
 * expressed in the projection's currency.
 */
export async function forecastWithScenario(
  options: ScenarioForecastOptions,
): Promise<CostScenarioProjection> {
  const { organizationId, model, baseline, filters, fitTo } = options;
  const adjustments = model.adjustments;

  const { amountRate, currency, convertedFrom } = resolveScenarioCurrency(options);

  // One sub-baseline per *distinct* scope, not per adjustment: three rate
  // changes all scoped to `provider = 'aws'` are one extra query, not three.
  // Only rate changes need one — an absolute amount is a number, not a
  // percentage of anything — so a model of pure amounts costs nothing extra.
  const scopeKeys = new Map<string, CostFilter[]>();
  for (const adjustment of adjustments) {
    if (adjustment.kind !== "rate_change") continue;
    const scope = adjustment.scope ?? [];
    if (scope.length === 0) continue;
    scopeKeys.set(costScenarioScopeKey(scope), scope);
  }

  const scopedBaselines = new Map<string, ScenarioDayPoint[]>();
  for (const [key, scope] of scopeKeys) {
    scopedBaselines.set(
      key,
      await scopedProjection({
        organizationId,
        // AND-composed with the chart's filters, never used in their place: a
        // rate change on a chart already narrowed to one account applies to
        // that account's share of the scope, not to the org's.
        filters: [...filters, ...scope],
        fitTo,
        horizonDays: baseline.length,
        ...(options.costBasis ? { costBasis: options.costBasis } : {}),
        ...(options.chargeTypes ? { chargeTypes: options.chargeTypes } : {}),
        displayCurrency: options.displayCurrency,
        rates: options.rates,
      }),
    );
  }

  return applyCostScenario({
    model,
    adjustments,
    baseline,
    scopedBaselines,
    chartFilters: filters,
    amountRate,
    currency,
    ...(convertedFrom ? { convertedFrom } : {}),
  });
}

/**
 * The rate the model's amounts are multiplied by before they are added, and the
 * currency the result is in.
 *
 * The cases, in order:
 *
 * - A model with **no amounts at all** (pure rate changes) is currency-free —
 *   a percentage of the trend is denominated in whatever the trend is. It
 *   applies to any projection.
 * - The projection is already in the model's currency: rate 1, no conversion.
 * - Conversion is active and the org has stated a rate from the model's
 *   currency to the display currency: convert, and say so on the result.
 * - Anything else throws. Adding dollars to a euro projection, or to a
 *   projection that is itself a sum of both, produces a number that means
 *   nothing — and it would sit on a chart under a confident dashed line.
 */
function resolveScenarioCurrency(options: ScenarioForecastOptions): {
  amountRate: number;
  currency: string;
  convertedFrom?: string;
} {
  const { model, baselineCurrency, displayCurrency, rates } = options;
  const hasAmounts = model.adjustments.some((a) => a.kind !== "rate_change");
  const target = displayCurrency ?? baselineCurrency;

  if (!hasAmounts) {
    return { amountRate: 1, currency: target ?? model.currency };
  }
  if (!target) {
    throw new CostScenarioApplicationError(
      `Scenario "${model.name}" carries ${model.currency} amounts, but this chart sums more than ` +
        "one currency. Set an organization display currency (Settings → Currency) so there is " +
        "one number for the scenario to adjust.",
    );
  }
  if (target === model.currency) return { amountRate: 1, currency: target };

  // One hop, the same rule `currency-convert.ts` follows: rates are stated to
  // the display currency and nothing here inverts or chains them.
  const applicable = rates
    .filter((r) => r.fromCurrency === model.currency && r.toCurrency === target)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  const rate = applicable[0];
  const parsed = rate ? Number(rate.rate) : NaN;
  if (!rate || !Number.isFinite(parsed) || parsed <= 0) {
    throw new CostScenarioApplicationError(
      `Scenario "${model.name}" is in ${model.currency} but this chart is in ${target}, and no ` +
        `${model.currency} → ${target} rate is configured. Add one (Settings → Currency) or ` +
        "write the scenario in the chart's currency — a projection must not silently sum two " +
        "kinds of money.",
    );
  }
  return { amountRate: parsed, currency: target, convertedFrom: model.currency };
}

/**
 * The trend projection for one narrowed scope, over the same horizon as the
 * chart's own — this is what a rate change's percentage is a percentage *of*.
 *
 * Fitted exactly the way the main forecast is (same window, same basis, same
 * charge types, converted before fitting), because a delta measured against a
 * differently-fitted baseline would not compose with it.
 */
async function scopedProjection(args: {
  organizationId: string;
  filters: CostFilter[];
  fitTo: string;
  horizonDays: number;
  costBasis?: CostBasis | undefined;
  chargeTypes?: CostChargeType[] | undefined;
  displayCurrency: string | null;
  rates: ExchangeRate[];
}): Promise<ScenarioDayPoint[]> {
  const groups = await queryCosts(args.organizationId, {
    from: addDays(args.fitTo, -(FIT_WINDOW_DAYS - 1)),
    to: args.fitTo,
    binning: "daily",
    groupBy: "none",
    filters: args.filters,
    ...(args.costBasis ? { costBasis: args.costBasis } : {}),
    ...(args.chargeTypes && args.chargeTypes.length > 0 ? { chargeTypes: args.chargeTypes } : {}),
  });
  const { groups: converted } = convertGroups(groups, args.displayCurrency, args.rates);

  const daily = new Map<string, number>();
  for (const group of converted) {
    for (const point of group.points) {
      daily.set(point.bucket, (daily.get(point.bucket) ?? 0) + point.amount);
    }
  }
  const observed: DailyPoint[] = [...daily.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, amount]) => ({ day, amount }));
  if (observed.length === 0) return [];

  return forecastDaily(observed, args.horizonDays).map((p) => ({ day: p.day, amount: p.amount }));
}
