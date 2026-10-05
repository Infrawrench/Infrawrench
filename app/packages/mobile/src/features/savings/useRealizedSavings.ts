import { useQuery } from "@tanstack/react-query";
import { fetchRealizedSavings } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The realized savings report (`GET /savings/realized`), default range (the
 * last 12 months). Recomputed server-side on every read, so pull-to-refresh
 * picks up restated billing.
 */
export function useRealizedSavings() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["realized-savings", orgId],
    queryFn: () => fetchRealizedSavings(api, orgId),
  });
}
