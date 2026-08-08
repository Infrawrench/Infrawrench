import { useQuery } from "@tanstack/react-query";
import { fetchStatusPages } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's public status pages (`GET /status-pages`) — which of its probes
 * are published, and whether each page is currently live.
 *
 * An ordinary read alongside `useProbes`, and read-only for the same reason:
 * publishing monitoring to the internet is a decision made on web or desktop,
 * with the component editor in front of you. What is worth having on a phone
 * is the answer to "is our status page live, and what does it say".
 */
export function useStatusPages() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["status-pages", orgId],
    queryFn: () => fetchStatusPages(api, orgId),
  });
}
