import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createJiraIssue,
  fetchJiraIntegration,
  fetchJiraIssueLinks,
  fetchJiraIssueTypes,
  fetchJiraProjects,
  indexJiraLinks,
  jiraLinkKey,
  type CreateJiraIssueArgs,
  type JiraIssueLink,
  type JiraSourceKind,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { useOrgPermissions } from "@/lib/permissions";

/**
 * Jira state for the mobile findings surfaces.
 *
 * Everything here is a thin react-query wrapper over the shared client in
 * `@infrawrench/client-core` — mobile cannot use `@infrawrench/ui`, so the
 * contract is shared at the client layer and only the components differ.
 *
 * The links query is fetched once per org and read per row, matching web: a
 * request per anomaly row would be a request per row on a phone connection.
 */

/** The org's Jira connection, or null when it is not connected. */
export function useJiraIntegration() {
  const { api, orgId } = useOrgApi();
  const { has } = useOrgPermissions();
  const canRead = has("jira:read");
  return useQuery({
    queryKey: ["jira-integration", orgId],
    queryFn: () => fetchJiraIntegration(api, orgId),
    enabled: canRead,
    staleTime: 5 * 60_000,
  });
}

/** Every filed link in the org, indexed for per-row lookup. */
export function useJiraLinks() {
  const { api, orgId } = useOrgApi();
  const { has } = useOrgPermissions();
  const canRead = has("jira:read");
  const query = useQuery({
    queryKey: ["jira-links", orgId],
    queryFn: () => fetchJiraIssueLinks(api, orgId),
    enabled: canRead,
  });
  const index = indexJiraLinks(query.data ?? []);
  return {
    linkFor: (sourceKind: JiraSourceKind, sourceId: string): JiraIssueLink | undefined =>
      index.get(jiraLinkKey(sourceKind, sourceId)),
    ...query,
  };
}

export function useJiraProjects(enabled: boolean) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["jira-projects", orgId],
    queryFn: () => fetchJiraProjects(api, orgId),
    enabled,
  });
}

export function useJiraIssueTypes(projectKey: string) {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["jira-issue-types", orgId, projectKey],
    queryFn: () => fetchJiraIssueTypes(api, orgId, projectKey),
    enabled: Boolean(projectKey),
  });
}

/**
 * File an issue. Invalidates the links query on success so every row showing
 * this finding flips to the filed state without a manual refresh.
 */
export function useFileJiraIssue() {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: CreateJiraIssueArgs) => createJiraIssue(api, orgId, args),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["jira-links", orgId] });
    },
  });
}

/**
 * Whether this viewer can file at all: Jira connected *and* `jira:write`.
 * Both halves matter — a button that opens a sheet which can only 403 is worse
 * than no button.
 */
export function useCanFileJira(): boolean {
  const { has } = useOrgPermissions();
  const integration = useJiraIntegration();
  return has("jira:write") && Boolean(integration.data);
}
