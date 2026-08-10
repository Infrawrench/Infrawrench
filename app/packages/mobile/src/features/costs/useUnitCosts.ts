import { useQueries, useQuery } from "@tanstack/react-query";
import {
  resolveCostDateRange,
  type BusinessMetric,
  type UnitCostQueryResponse,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * Unit-cost reads for the Costs tab: the org's business metrics and, for each,
 * the trailing 30 days of cost per unit.
 *
 * Read-only on mobile, and deliberately so — declaring what the business
 * counts, what one of it is called and which spend it divides is a
 * finance-governance act on the same footing as stating an exchange rate or
 * setting the tag policy (`costs:write`, org-wide consequences, and an editor
 * that needs the full cost-filter builder). The phone's job is to answer "what
 * is a customer costing us this month" while you are away from a desk.
 */
export function useBusinessMetrics() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["business-metrics", orgId],
    queryFn: async () =>
      (await api.org<{ metrics: BusinessMetric[] }>(orgId, "/business-metrics"))?.metrics ?? [],
  });
}

/**
 * How many metrics get a card. The phone is a glance surface and each card is
 * its own round trip; the web panel is where a long list belongs.
 */
export const MOBILE_UNIT_COST_METRIC_LIMIT = 4;

/**
 * One trailing-30-day unit-cost series per metric, in parallel.
 *
 * The range and binning come from the shared `resolveCostDateRange` rather than
 * a local date computation, so a bar on the phone covers exactly the days the
 * dashboard card it mirrors covers.
 */
export function useUnitCostSeries(metrics: BusinessMetric[]) {
  const { api, orgId } = useOrgApi();
  const { from, to } = resolveCostDateRange({ kind: "relative", preset: "30d" });
  return useQueries({
    queries: metrics.slice(0, MOBILE_UNIT_COST_METRIC_LIMIT).map((metric) => ({
      queryKey: ["unit-costs", orgId, metric.id, from, to],
      queryFn: () =>
        api.org<UnitCostQueryResponse>(orgId, `/business-metrics/${metric.id}/unit-costs`, {
          method: "POST",
          body: JSON.stringify({ from, to, binning: "daily" as const }),
        }),
    })),
  });
}
