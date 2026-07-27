import { useQuery } from "@tanstack/react-query";
import type { CostAccountStatus } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * Per-account cost collection state, backing {@link CostCollectionNotice}.
 *
 * Any cost surface is only as good as the collection behind it, so the
 * dashboard and the Costs tab share one query — and one cache key, so opening
 * both does not fetch it twice.
 */
export function useCostStatus(enabled = true) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["cost-status", orgId],
    enabled,
    queryFn: async () =>
      (await api.org<{ accounts: CostAccountStatus[] }>(orgId, "/costs/status"))?.accounts ?? [],
  });
}
