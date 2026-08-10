import { useQuery } from "@tanstack/react-query";
import { fetchProbes } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's synthetic probes (`GET /probes`): every uptime/latency check with
 * its live status, last latency and trailing-24h uptime. An ordinary read —
 * the checks themselves run server-side on the poller, so this is the same
 * shape as `useExpiring`.
 */
export function useProbes() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["probes", orgId],
    queryFn: () => fetchProbes(api, orgId),
  });
}
