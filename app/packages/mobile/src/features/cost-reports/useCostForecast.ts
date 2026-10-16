import { useQuery } from "@tanstack/react-query";
import { runCostForecast } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * A report's forecasts: the automatic one and every named one, each with its
 * low/expected/high band, over the default 90-day window.
 *
 * Read-only on mobile, like the reports themselves: composing a forecast means
 * ordering scenario models and picking a driver metric, which stays on web and
 * desktop. A phone reads the projection; it doesn't build one.
 */
export function useCostForecast(reportId: string | undefined) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-forecast", orgId, reportId ?? null],
    enabled: Boolean(reportId),
    queryFn: () => runCostForecast(api, orgId, reportId!, { all: true }),
  });
}
