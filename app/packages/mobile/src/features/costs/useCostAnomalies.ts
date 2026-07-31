import { useQuery } from "@tanstack/react-query";
import { COST_ANOMALY_WINDOW, listCostAnomalies } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/** How far back the mobile anomalies section looks — the same 30 days web shows. */
export const ANOMALY_WINDOW_DAYS = COST_ANOMALY_WINDOW.defaultDays;

/**
 * Recent spend anomalies for the org (`GET /costs/anomalies`).
 *
 * Detection runs server-side after each cost collection pass, so this is a
 * plain read: there is nothing for a phone to trigger, and nothing to poll for
 * — a pull-to-refresh on the Costs tab is the only reason it refetches.
 */
export function useCostAnomalies(days = ANOMALY_WINDOW_DAYS) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-anomalies", orgId, days],
    queryFn: () => listCostAnomalies(api, orgId, days),
  });
}
