/**
 * Org-scoped unit-cost query execution — shared by the HTTP route
 * (api/routes/business-metrics.ts), the MCP tools and the CLI, exactly the way
 * `services/cost-query.ts` is shared, so every surface divides the same
 * numerator by the same denominator.
 *
 * The shape of the work, and why it is this shape:
 *
 * 1. **Numerator** — one `queryCosts` call, ungrouped, bucketed by the caller's
 *    binning. Grouping is deliberately not offered: a per-group ratio needs a
 *    per-group denominator, and the org has declared exactly one series of
 *    values. Drawing "cost per customer, by service" would silently divide each
 *    service's spend by the *whole* customer count and produce five numbers
 *    that do not sum to the real one.
 * 2. **Currency** — conversion happens here, on the already-aggregated series,
 *    through the same pure `convertGroups` the cost graph uses. Nothing is
 *    re-implemented and nothing is dropped: a currency with no rate keeps its
 *    own series (rule 4 in `cost/unit-costs.ts`).
 * 3. **Denominator** — one range read of `business_metric_values`.
 * 4. **The division** — `computeUnitCosts`, which is pure and holds every
 *    correctness rule the feature stands on.
 *
 * Steps 1 and 3 are the cross-store part, and they meet exactly once: two
 * already-aggregated lists combined at the bucket level. There is no per-point
 * join anywhere, which is what makes storing the denominator in Postgres the
 * cheap option rather than the expensive one.
 */
import {
  BUSINESS_METRIC_LIMITS,
  CostQueryParseError,
  parseCostQuery,
  type BusinessMetric,
  type CostFilter,
  type UnitCostMode,
  type UnitCostQueryRequest,
  type UnitCostQueryResponse,
} from "@infrawrench/client-core";
import { queryCosts } from "@infrawrench/server-core/clickhouse/cost-readers";
import {
  convertGroups,
  mergeConvertedGroups,
} from "@infrawrench/server-core/cost/currency-convert";
import {
  listOrgExchangeRates,
  loadConversionContext,
} from "@infrawrench/server-core/cost/currency-settings";
import {
  SavedCostFilterResolutionError,
  resolveSavedCostFilters,
} from "@infrawrench/server-core/cost/saved-filters";
import { getMetricValues } from "@infrawrench/server-core/cost/metric-ingest";
import { computeUnitCosts } from "@infrawrench/server-core/cost/unit-costs";

import { getBusinessMetric } from "./business-metrics";
import { CostQueryError } from "./cost-query";

export { CostQueryError };

/** The metric named by the request does not exist (or was deleted). */
export class BusinessMetricNotFoundError extends Error {
  override readonly name = "BusinessMetricNotFoundError";

  constructor(keyOrId: string) {
    super(`No business metric "${keyOrId}" in this organization.`);
  }
}

function daySpan(from: string, to: string): number {
  return (
    Math.round(
      (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) /
        86_400_000,
    ) + 1
  );
}

/**
 * The filters the numerator actually runs: the metric's own `costScope` and
 * saved filter, AND-composed with whatever narrowing the request added.
 *
 * Composition, never replacement. The scope is part of what the metric *means*
 * — "cost per customer" is only honest if the numerator is the spend that
 * serves customers — so a caller can narrow it (this service, this account) but
 * has no way to widen it. A request that could drop the scope would be
 * answering a different question under the same name.
 */
async function resolveNumeratorFilters(
  organizationId: string,
  metric: BusinessMetric,
  request: UnitCostQueryRequest,
): Promise<CostFilter[]> {
  const filters: CostFilter[] = [...metric.costScope];

  if (metric.savedFilterId) {
    try {
      filters.push(...(await resolveSavedCostFilters(organizationId, metric.savedFilterId)));
    } catch (e) {
      if (e instanceof SavedCostFilterResolutionError) {
        // Never a fall-through to unfiltered spend: a numerator that quietly
        // widened to the whole estate would inflate every unit cost on the
        // chart while looking entirely normal.
        throw new CostQueryError(
          `This metric's saved cost filter could not be resolved, so its unit costs cannot be ` +
            `computed: ${e.message}`,
        );
      }
      throw e;
    }
  }

  const inline = request.filters ?? [];
  const text = request.query?.trim();
  if (text && inline.length > 0) {
    throw new CostQueryError(
      "Send either `filters` or `query`, not both — they are two spellings of the same filter, " +
        "and running one while ignoring the other would silently answer a different question.",
    );
  }
  if (text) {
    try {
      filters.push(...parseCostQuery(text));
    } catch (e) {
      if (e instanceof CostQueryParseError) {
        throw new CostQueryError(`Invalid query at offset ${e.offset}: ${e.message}`, {
          offset: e.offset,
          length: e.length,
          expected: [...e.expected],
        });
      }
      throw e;
    }
  } else {
    filters.push(...inline);
  }

  if (request.savedFilterId) {
    try {
      filters.push(...(await resolveSavedCostFilters(organizationId, request.savedFilterId)));
    } catch (e) {
      if (e instanceof SavedCostFilterResolutionError) throw new CostQueryError(e.message);
      throw e;
    }
  }

  return filters;
}

/**
 * Which currency the numerator has to be expressed in, and the rates to get it
 * there.
 *
 * Two different questions wearing one name, so they are answered separately:
 *
 * - **Unit cost** asks the *display* question — "show me one number instead of
 *   three" — and is therefore governed by the org's opt-in display currency,
 *   through the same `loadConversionContext` policy every cost query uses. No
 *   request, no conversion.
 * - **Margin** asks an *arithmetic* question. `(revenue − cost) ÷ revenue`
 *   subtracts money from money and is undefined across currencies, so the
 *   target is always the metric's own currency regardless of what the org
 *   displays in — and the rate table is loaded directly rather than through the
 *   display-currency gate, which would refuse any currency but the configured
 *   one. `convertGroups` is still the only thing doing arithmetic; this only
 *   decides what to point it at.
 */
async function resolveConversion(
  organizationId: string,
  metric: BusinessMetric,
  mode: UnitCostMode,
  requested: string | undefined,
) {
  if (mode === "margin") {
    return {
      displayCurrency: metric.currency,
      rates: metric.currency ? await listOrgExchangeRates(organizationId) : [],
    };
  }
  return loadConversionContext(organizationId, requested);
}

/**
 * Aggregate a unit-cost (or margin) series for a metric.
 *
 * @throws {BusinessMetricNotFoundError} when the metric does not exist.
 * @throws {CostQueryError} for anything else the caller can fix.
 */
export async function runUnitCostQuery(
  organizationId: string,
  metricKeyOrId: string,
  request: UnitCostQueryRequest,
): Promise<UnitCostQueryResponse> {
  if (request.from > request.to) throw new CostQueryError("from must not be after to");
  if (daySpan(request.from, request.to) > 1100) throw new CostQueryError("Date range too large");

  const metric = await getBusinessMetric(organizationId, metricKeyOrId);
  if (!metric) throw new BusinessMetricNotFoundError(metricKeyOrId);

  const mode: UnitCostMode = request.mode ?? "unit_cost";
  if (mode === "margin" && metric.kind !== "currency") {
    // The one refusal worth making loudly rather than rendering. Margin against
    // a count subtracts dollars from requests and divides by requests: it type
    // checks, it produces a number, and the number means nothing. A metric
    // declares its kind once so this can be caught here instead of by whoever
    // reads the chart.
    throw new CostQueryError(
      `Margin needs a revenue metric — "${metric.key}" counts ${metric.unit || "units"}, not ` +
        'money. Declare a metric with kind "currency" and its currency to compute margin.',
    );
  }

  const filters = await resolveNumeratorFilters(organizationId, metric, request);
  const { displayCurrency, rates } = await resolveConversion(
    organizationId,
    metric,
    mode,
    request.displayCurrency,
  );

  const [rawGroups, values] = await Promise.all([
    queryCosts(organizationId, {
      from: request.from,
      to: request.to,
      binning: request.binning,
      // Ungrouped on purpose — see the module comment. Currencies still come
      // back separately; `queryCosts` never merges those.
      groupBy: "none",
      filters,
      ...(request.costBasis ? { costBasis: request.costBasis } : {}),
      ...(request.chargeTypes && request.chargeTypes.length > 0
        ? { chargeTypes: request.chargeTypes }
        : {}),
    }),
    getMetricValues(metric.id, request.from, request.to),
  ]);

  const { groups: converted, conversion } = convertGroups(rawGroups, displayCurrency, rates);
  // Merge first, then divide: conversion turns "spend in EUR" and "spend in
  // USD" into two USD groups with the same (empty) key, and dividing each by
  // the full denominator separately would draw two lines that each understate
  // the real unit cost.
  const costGroups = mergeConvertedGroups(converted);

  const { series, gapBuckets, partialBuckets } = computeUnitCosts({
    from: request.from,
    to: request.to,
    binning: request.binning,
    mode,
    costGroups,
    values,
    metricCurrency: metric.currency,
  });

  const response: UnitCostQueryResponse = {
    metric: {
      id: metric.id,
      key: metric.key,
      name: metric.name,
      unit: metric.unit,
      kind: metric.kind,
      currency: metric.currency,
    },
    mode,
    binning: request.binning,
    series,
    gapBuckets,
    partialBuckets,
  };
  // Only set when something was actually converted — its absence is how a
  // client knows the per-currency numbers are the literal collected ones.
  if (conversion) response.conversion = conversion;
  return response;
}

/** The page size `GET /business-metrics/{id}/values` clamps to. */
export const MAX_METRIC_VALUES_PAGE = BUSINESS_METRIC_LIMITS.maxValuesPageSize;
