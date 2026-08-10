import { useQuery } from "@tanstack/react-query";
import { fetchExpiring } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's expiry feed (`GET /expiring`): every declared deadline on every
 * synced resource — TLS certs, domains, API tokens, access-key ages — soonest
 * first, with per-severity counts.
 *
 * The scan is server-side and cheap: it classifies rows the org has already
 * synced against the plugins' `expiryFields` declarations and makes no
 * provider API calls, so this is an ordinary read with no special caching —
 * the same shape as `useOrphans`.
 */
export function useExpiring() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["expiring", orgId],
    queryFn: () => fetchExpiring(api, orgId),
  });
}
