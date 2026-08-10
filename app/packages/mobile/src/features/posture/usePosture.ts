import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  dismissPostureFinding,
  fetchPosture,
  restorePostureFinding,
  type PostureFinding,
} from "@infrawrench/client-core";
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

/**
 * Accept a finding as a known risk, or put an accepted one back. Both
 * invalidate the feed rather than patching it locally: the server decides
 * what is dismissed, and a partition it computed is not worth re-deriving on
 * the phone.
 *
 * Needs `resources:write`; a member's tap comes back 403, which the screen
 * surfaces as the error it is rather than pre-hiding the control (mobile has
 * no permissions context to ask).
 */
export function usePostureDismissal() {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["posture", orgId] });

  const dismiss = useMutation({
    mutationFn: (input: { finding: PostureFinding; reason?: string }) =>
      dismissPostureFinding(api, orgId, {
        resourceId: input.finding.resourceId,
        ruleId: input.finding.ruleId,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    onSuccess: invalidate,
  });

  const restore = useMutation({
    mutationFn: (finding: PostureFinding) =>
      restorePostureFinding(api, orgId, {
        resourceId: finding.resourceId,
        ruleId: finding.ruleId,
      }),
    onSuccess: invalidate,
  });

  return { dismiss, restore };
}
