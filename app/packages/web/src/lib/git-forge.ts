import { useCallback } from "react";
import { useGitForgeLinkFrom, type GitForgeLink } from "@infrawrench/ui";
import type { GitForgeOverview } from "@infrawrench/client-core";
import { apiGet } from "@/lib/api";

/**
 * Where the Git entry opens: the organisation's namespace on
 * git.infrawrench.com. Follows a claim or rename made in Settings > Git
 * without a reload; see `useGitForgeLinkFrom`.
 */
export function useGitForgeLink(orgId: string | undefined): GitForgeLink {
  const load = useCallback(() => apiGet<GitForgeOverview>(`/api/org/${orgId}/git`), [orgId]);
  return useGitForgeLinkFrom(orgId, load);
}
