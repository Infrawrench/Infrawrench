import { useQuery } from "@tanstack/react-query";
import {
  doraRangeForDays,
  fetchDoraChanges,
  fetchDoraReport,
  type DoraQuery,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/** The query for the last `days` days, anchored when the inputs change. */
export function doraQuery(days: number, groupBy: string): DoraQuery {
  return { ...doraRangeForDays(days), groupBy };
}

/** The DORA report (`GET /dora`); production only, like the web panel. */
export function useDoraReport(days: number, groupBy: string) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["dora", orgId, days, groupBy],
    queryFn: () => fetchDoraReport(api, orgId, doraQuery(days, groupBy)),
  });
}

/** The drill-down (`GET /dora/changes`), newest first. */
export function useDoraChanges(days: number, failedOnly: boolean) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["dora", orgId, "changes", days, failedOnly],
    queryFn: () => fetchDoraChanges(api, orgId, { ...doraRangeForDays(days), failedOnly }),
  });
}
