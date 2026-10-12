import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  dismissVulnerability,
  fetchVulnerabilities,
  restoreVulnerability,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * The org's vulnerability feed (`GET /vulnerabilities`): what each connected
 * scanner reported, joined server-side to the synced resources running the
 * affected image, with dismissals and the CISA KEV catalog already applied.
 *
 * Like posture, the read makes no provider calls (the poller collects), so it
 * is an ordinary query with no special caching.
 */
export function useVulnerabilities() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["vulnerabilities", orgId],
    queryFn: () => fetchVulnerabilities(api, orgId),
  });
}

/**
 * Accept an advisory as a known risk (for one artifact, or everywhere with
 * `artifactKey: "*"`), or put a dismissal back. Both invalidate the feed: the
 * server owns the partition, and a `"*"` dismissal moves rows the phone would
 * otherwise have to find itself.
 *
 * Needs `resources:write`; a member's tap comes back 403, surfaced as the
 * error it is (the posture stance: mobile has no permissions context to ask).
 */
export function useVulnerabilityDismissal() {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["vulnerabilities", orgId] });

  const dismiss = useMutation({
    mutationFn: (input: { advisoryId: string; artifactKey: string }) =>
      dismissVulnerability(api, orgId, input),
    onSuccess: invalidate,
  });

  const restore = useMutation({
    mutationFn: (input: { advisoryId: string; artifactKey: string }) =>
      restoreVulnerability(api, orgId, input),
    onSuccess: invalidate,
  });

  return { dismiss, restore };
}
