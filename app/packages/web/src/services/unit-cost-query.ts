/**
 * Org-scoped unit-cost query execution: shared by the HTTP route
 * (api/routes/business-metrics.ts), the MCP tools and the CLI, exactly the way
 * `services/cost-query.ts` is shared, so every surface divides the same
 * numerator by the same denominator.
 *
 * The calculation itself lives in `server-core/cost/unit-cost-run.ts`, because
 * the poller's threshold evaluator has to judge exactly the number the chart
 * draws and the poller does not depend on this package. This file is the web
 * side's error vocabulary around it: a missing metric is a 404, anything else
 * the caller can fix is a `CostQueryError`.
 */
import { getCostUsageUnitSummaries } from "@infrawrench/server-core/clickhouse/cost-readers";
import {
  UnitCostRunError,
  runUnitCostCalculation,
} from "@infrawrench/server-core/cost/unit-cost-run";
import type { UnitCostQueryRequest, UnitCostQueryResponse } from "@infrawrench/client-core";

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

function asCostQueryError(e: unknown): never {
  if (e instanceof UnitCostRunError) throw new CostQueryError(e.message, e.queryError);
  throw e;
}

/**
 * Aggregate a unit-cost, margin, or raw-metric series for a metric.
 *
 * @throws {BusinessMetricNotFoundError} when the metric does not exist.
 * @throws {CostQueryError} for anything else the caller can fix.
 */
export async function runUnitCostQuery(
  organizationId: string,
  metricKeyOrId: string,
  request: UnitCostQueryRequest,
): Promise<UnitCostQueryResponse> {
  const metric = await getBusinessMetric(organizationId, metricKeyOrId);
  if (!metric) throw new BusinessMetricNotFoundError(metricKeyOrId);
  if (request.mode === "usage_unit_cost") {
    throw new CostQueryError(
      "Cost per usage unit divides by provider usage, not by a metric; use " +
        "POST /business-metrics/usage-unit-costs.",
    );
  }
  try {
    return await runUnitCostCalculation(organizationId, metric, request);
  } catch (e) {
    return asCostQueryError(e);
  }
}

/**
 * Spend divided by the usage quantity providers report in one unit: no
 * business metric involved.
 *
 * @throws {CostQueryError} for anything the caller can fix.
 */
export async function runUsageUnitCostQuery(
  organizationId: string,
  request: UnitCostQueryRequest,
): Promise<UnitCostQueryResponse> {
  try {
    return await runUnitCostCalculation(organizationId, null, {
      ...request,
      mode: "usage_unit_cost",
    });
  } catch (e) {
    return asCostQueryError(e);
  }
}

/** Default look-back for the usage-unit picker: one quarter of cost rows. */
const USAGE_UNIT_LOOKBACK_DAYS = 90;

/** The usage units the org's cost rows carry, most spend first. */
export async function listUsageUnits(
  organizationId: string,
  now = new Date(),
): Promise<Array<{ unit: string; usage: number; services: string[] }>> {
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - USAGE_UNIT_LOOKBACK_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return getCostUsageUnitSummaries(organizationId, { from, to });
}
