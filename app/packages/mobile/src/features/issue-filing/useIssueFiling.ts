import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createLinearIssue,
  fetchLinearIntegration,
  fetchLinearIssueLinks,
  fetchLinearTeams,
  indexLinearLinks,
  linearLinkKey,
  type CreateLinearIssueArgs,
  type IssueLinksForSource,
  type IssueTracker,
  type JiraSourceKind,
  type LinearIssueLink,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { useOrgPermissions } from "@/lib/permissions";
import { useCanFileJira, useJiraLinks } from "../jira/useJira";

/**
 * Tracker-aware issue-filing state for the mobile findings surfaces — the
 * native counterpart of `IssueFilingProvider` in `@infrawrench/ui`, which
 * mobile cannot use. The Jira half lives in `../jira/useJira` unchanged; this
 * module adds the Linear half and the combined views a findings row wants:
 * which trackers can be filed to, and every tracker's link for one finding.
 *
 * Same batching rule as everywhere else: the links queries are fetched once
 * per org and read per row — a request per anomaly row would be a request per
 * row on a phone connection.
 */

export type { IssueTracker };

/** The org's Linear connection, or null when it is not connected. */
export function useLinearIntegration() {
  const { api, orgId } = useOrgApi();
  const { has } = useOrgPermissions();
  const canRead = has("linear:read");
  return useQuery({
    queryKey: ["linear-integration", orgId],
    queryFn: () => fetchLinearIntegration(api, orgId),
    enabled: canRead,
    staleTime: 5 * 60_000,
  });
}

/** Every filed Linear link in the org, indexed for per-row lookup. */
export function useLinearLinks() {
  const { api, orgId } = useOrgApi();
  const { has } = useOrgPermissions();
  const canRead = has("linear:read");
  const query = useQuery({
    queryKey: ["linear-links", orgId],
    queryFn: () => fetchLinearIssueLinks(api, orgId),
    enabled: canRead,
  });
  const index = indexLinearLinks(query.data ?? []);
  return {
    linkFor: (sourceKind: JiraSourceKind, sourceId: string): LinearIssueLink | undefined =>
      index.get(linearLinkKey(sourceKind, sourceId)),
    ...query,
  };
}

export function useLinearTeams(enabled: boolean) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["linear-teams", orgId],
    queryFn: () => fetchLinearTeams(api, orgId),
    enabled,
  });
}

/**
 * File a Linear issue. Invalidates the links query on success so every row
 * showing this finding flips to the filed state without a manual refresh.
 */
export function useFileLinearIssue() {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: CreateLinearIssueArgs) => createLinearIssue(api, orgId, args),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["linear-links", orgId] });
    },
  });
}

/**
 * Whether this viewer can file into Linear at all: Linear connected *and*
 * `linear:write`. Both halves matter — a button that opens a sheet which can
 * only 403 is worse than no button.
 */
export function useCanFileLinear(): boolean {
  const { has } = useOrgPermissions();
  const integration = useLinearIntegration();
  return has("linear:write") && Boolean(integration.data);
}

/**
 * The trackers the viewer can file this org's findings to, in the order the
 * sheet offers them. Empty means "render no file affordance at all".
 */
export function useFilableTrackers(): IssueTracker[] {
  const jira = useCanFileJira();
  const linear = useCanFileLinear();
  const trackers: IssueTracker[] = [];
  if (jira) trackers.push("jira");
  if (linear) trackers.push("linear");
  return trackers;
}

/** What a findings row knows about where it has already been filed. */
export type { IssueLinksForSource };

/**
 * Every tracker's link for one finding — both, when it was filed to both.
 * One hook call per list, one `linksFor` call per row.
 */
export function useIssueLinks() {
  const jira = useJiraLinks();
  const linear = useLinearLinks();
  return {
    linksFor: (sourceKind: JiraSourceKind, sourceId: string): IssueLinksForSource => ({
      jira: jira.linkFor(sourceKind, sourceId),
      linear: linear.linkFor(sourceKind, sourceId),
    }),
  };
}
