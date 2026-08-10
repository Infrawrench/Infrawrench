import { useQuery } from "@tanstack/react-query";
import { fetchDnsInventory } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's DNS inventory (`GET /dns`): every zone and record across every
 * connected provider, with each record's target classified against the rest of
 * the workspace — worst status first, with per-status counts.
 *
 * The scan is server-side and cheap: it reads rows the org has already synced
 * and makes no provider API calls and no DNS queries, so this is an ordinary
 * read with no special caching — the same shape as `usePosture`.
 */
export function useDns() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["dns", orgId],
    queryFn: () => fetchDnsInventory(api, orgId),
  });
}
