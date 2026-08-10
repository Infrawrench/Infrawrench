import { useQuery } from "@tanstack/react-query";
import { fetchOrphans } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * Likely-wasted resources across the org (`GET /orphans`).
 *
 * The scan is server-side and cheap — it classifies rows the org has already
 * synced and makes no provider API calls — so this is an ordinary read with no
 * special caching. Freshness follows the poller: a volume detached a minute
 * ago shows up after the next account sync, not on the next refetch.
 */
export function useOrphans() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["orphans", orgId],
    queryFn: () => fetchOrphans(api, orgId),
  });
}
