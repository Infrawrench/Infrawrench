import { useQuery } from "@tanstack/react-query";
import { fetchSloDetail, fetchSlos } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's SLOs (`GET /slos`): every objective with its last snapshot. An
 * ordinary read; evaluation runs on the poller, so this is the `useProbes`
 * shape.
 */
export function useSlos() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["slos", orgId],
    queryFn: () => fetchSlos(api, orgId),
  });
}

/** One SLO with its hourly history over the window (`GET /slos/:id`). */
export function useSloDetail(sloId: string) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["slos", orgId, sloId],
    queryFn: () => fetchSloDetail(api, orgId, sloId),
    enabled: !!sloId,
  });
}
