import { useQuery } from "@tanstack/react-query";
import { fetchRightsizing } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * Oversized-resource recommendations (`GET /rightsizing`). Server-side the
 * result is computed from 14 days of stored metrics plus the providers' size
 * catalogs and cached for a few minutes, so this is an ordinary read — the
 * pull-to-refresh on the Costs tab refetches through that cache.
 */
export function useRightsizing() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["rightsizing", orgId],
    queryFn: () => fetchRightsizing(api, orgId),
  });
}
