import { useQuery } from "@tanstack/react-query";
import type {
  ShowbackReport,
  TagComplianceReport,
  UntaggedSpendReport,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * Tag governance reads for the Costs tab: the org's tag policy with
 * per-account compliance (`GET /tag-policy/compliance`) and untagged spend
 * over the required keys (`GET /costs/untagged`, trailing 30 days by
 * default). Read-only on mobile — the policy, cost centres, and allocation
 * rules are edited from the web app's org settings.
 */
export function useTagCompliance() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["tag-compliance", orgId],
    queryFn: () => api.org<TagComplianceReport>(orgId, "/tag-policy/compliance"),
  });
}

export function useUntaggedSpend() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["untagged-spend", orgId],
    queryFn: () => api.org<UntaggedSpendReport>(orgId, "/costs/untagged"),
  });
}

/**
 * Showback: spend by cost centre, as the depth-first tree the server already
 * builds. Read-only like the rest of this file — the centre tree is created,
 * renamed and moved from the web app's org settings, so the phone shows the
 * answer without carrying a tree editor.
 */
export function useShowback() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["showback", orgId],
    queryFn: () => api.org<ShowbackReport>(orgId, "/costs/showback"),
  });
}
