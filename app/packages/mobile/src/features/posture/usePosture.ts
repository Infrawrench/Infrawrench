import { useQuery } from "@tanstack/react-query";
import { fetchPosture } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's posture findings (`GET /posture`): every matched plugin-declared
 * security check on every synced resource — public buckets, world-open
 * ingress, unencrypted disks, stale credentials — worst severity first, with
 * per-severity counts.
 *
 * The scan is server-side and cheap: it classifies rows the org has already
 * synced against the plugins' `postureChecks` declarations and makes no
 * provider API calls, so this is an ordinary read with no special caching —
 * the same shape as `useExpiring`.
 */
export function usePosture() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["posture", orgId],
    queryFn: () => fetchPosture(api, orgId),
  });
}
