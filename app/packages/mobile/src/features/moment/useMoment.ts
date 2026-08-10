import { useQuery } from "@tanstack/react-query";
import { fetchMoment } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * One merged window from `GET /moment`. `at` undefined = "around now" — the
 * server centres on its clock at fetch time, so pull-to-refresh recentres.
 */
export function useMoment(at: string | undefined, windowMinutes: number) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["moment", orgId, at ?? null, windowMinutes],
    queryFn: () => fetchMoment(api, orgId, { ...(at ? { at } : {}), windowMinutes }),
  });
}
