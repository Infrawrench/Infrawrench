import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  githubLinkKey,
  indexGithubLinks,
  indexJiraLinks,
  indexLinearLinks,
  jiraLinkKey,
  linearLinkKey,
  type GithubIssueLink,
  type GithubIssuesStatus,
  type IssueLinksForSource,
  type IssueTracker,
  type JiraIntegration,
  type JiraIssueLink,
  type JiraSourceKind,
  type LinearIntegration,
  type LinearIssueLink,
} from "@infrawrench/client-core";

/**
 * Host-injected transport for the issue-filing affordance. The same two verbs
 * the settings sections use; web wraps `apiFetch`, desktop wraps the cloud IPC
 * proxy, so the components stay platform-agnostic.
 */
export interface IssueFilingApi {
  get<T>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
}

/** The trackers a finding can be filed to. Client-core (`issue-filing.ts`) owns both shapes. */
export type { IssueLinksForSource, IssueTracker };

export interface IssueFilingHostProps {
  orgId: string;
  api: IssueFilingApi;
  /** Caller holds `jira:read`: without it there is nothing to fetch for Jira. */
  canReadJira: boolean;
  /** Caller holds `jira:write`: without it Jira never appears as a filing target. */
  canFileJira: boolean;
  /** Caller holds `linear:read`. */
  canReadLinear: boolean;
  /** Caller holds `linear:write`. */
  canFileLinear: boolean;
  /** Caller holds `github-issues:read`. Optional so older hosts keep compiling. */
  canReadGithub?: boolean;
  /** Caller holds `github-issues:write`: filing and IaC pull requests. */
  canFileGithub?: boolean;
  /** Open the filed issue in a new tab (web) or the system browser (desktop). */
  openExternal: (url: string) => void;
  children: ReactNode;
}

export interface IssueFilingValue {
  orgId: string;
  api: IssueFilingApi;
  openExternal: (url: string) => void;
  /** Null until loaded, and stays null when the tracker is not connected. */
  jiraIntegration: JiraIntegration | null;
  linearIntegration: LinearIntegration | null;
  /** GitHub issue settings and installation access; null until loaded or unreadable. */
  githubStatus: GithubIssuesStatus | null;
  /** True when IaC pull requests are enabled and the caller may open them. */
  canOpenPullRequests: boolean;
  /** Trackers the caller can actually file to: connected AND `:write` held. */
  filableTrackers: IssueTracker[];
  /** Every tracker's link for one finding: both, when it was filed to both. */
  linksFor: (sourceKind: JiraSourceKind, sourceId: string) => IssueLinksForSource;
  onJiraFiled: (link: JiraIssueLink) => void;
  onLinearFiled: (link: LinearIssueLink) => void;
  onGithubFiled: (link: GithubIssueLink) => void;
}

const IssueFilingContext = createContext<IssueFilingValue | null>(null);

/**
 * Makes "file this finding as an issue" available to every findings list
 * underneath it, for whichever trackers the org has connected: Jira, Linear,
 * or both.
 *
 * The provider (not the button) owns the reads, and that is the point: it
 * fetches each connected tracker's integration once and **every** issue link
 * once, so a page showing a hundred findings costs a handful of requests
 * rather than hundreds. Individual buttons then resolve their own state from
 * the in-memory indexes.
 *
 * All reads fail soft. A findings page is about findings; if a tracker or the
 * database is unreachable the page still renders, just without badges or
 * buttons. The user-initiated create is the opposite: see
 * {@link FileIssueModal}, which surfaces its failures.
 */
export function IssueFilingProvider({
  orgId,
  api,
  canReadJira,
  canFileJira,
  canReadLinear,
  canFileLinear,
  canReadGithub = false,
  canFileGithub = false,
  openExternal,
  children,
}: IssueFilingHostProps) {
  const [jiraIntegration, setJiraIntegration] = useState<JiraIntegration | null>(null);
  const [linearIntegration, setLinearIntegration] = useState<LinearIntegration | null>(null);
  const [jiraLinks, setJiraLinks] = useState<Map<string, JiraIssueLink>>(() => new Map());
  const [linearLinks, setLinearLinks] = useState<Map<string, LinearIssueLink>>(() => new Map());
  const [githubStatus, setGithubStatus] = useState<GithubIssuesStatus | null>(null);
  const [githubLinks, setGithubLinks] = useState<Map<string, GithubIssueLink>>(() => new Map());

  useEffect(() => {
    if (!canReadGithub) {
      setGithubStatus(null);
      setGithubLinks(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<GithubIssuesStatus>(`/api/org/${orgId}/github-issues`);
        if (!cancelled) setGithubStatus(res);
      } catch {
        if (!cancelled) setGithubStatus(null);
      }
    })();
    void (async () => {
      try {
        const rows = await api.get<GithubIssueLink[]>(`/api/org/${orgId}/github-issues/links`);
        if (!cancelled) setGithubLinks(indexGithubLinks(rows));
      } catch {
        if (!cancelled) setGithubLinks(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId, canReadGithub]);

  useEffect(() => {
    if (!canReadJira) {
      setJiraIntegration(null);
      setJiraLinks(new Map());
      return;
    }
    let cancelled = false;
    // Awaited inside try/catch rather than chained off .catch(): a host's
    // implementation may throw synchronously (desktop's requires cloud mode),
    // and a synchronous throw escapes a promise chain entirely.
    void (async () => {
      try {
        const res = await api.get<{ integration: JiraIntegration | null }>(
          `/api/org/${orgId}/jira`,
        );
        if (!cancelled) setJiraIntegration(res.integration);
      } catch {
        if (!cancelled) setJiraIntegration(null);
      }
    })();
    void (async () => {
      try {
        const rows = await api.get<JiraIssueLink[]>(`/api/org/${orgId}/jira/links`);
        if (!cancelled) setJiraLinks(indexJiraLinks(rows));
      } catch {
        if (!cancelled) setJiraLinks(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId, canReadJira]);

  useEffect(() => {
    if (!canReadLinear) {
      setLinearIntegration(null);
      setLinearLinks(new Map());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<{ integration: LinearIntegration | null }>(
          `/api/org/${orgId}/linear`,
        );
        if (!cancelled) setLinearIntegration(res.integration);
      } catch {
        if (!cancelled) setLinearIntegration(null);
      }
    })();
    void (async () => {
      try {
        const rows = await api.get<LinearIssueLink[]>(`/api/org/${orgId}/linear/links`);
        if (!cancelled) setLinearLinks(indexLinearLinks(rows));
      } catch {
        if (!cancelled) setLinearLinks(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId, canReadLinear]);

  const linksFor = useCallback(
    (sourceKind: JiraSourceKind, sourceId: string): IssueLinksForSource => ({
      jira: jiraLinks.get(jiraLinkKey(sourceKind, sourceId)),
      linear: linearLinks.get(linearLinkKey(sourceKind, sourceId)),
      github: githubLinks.get(githubLinkKey(sourceKind, sourceId)),
    }),
    [jiraLinks, linearLinks, githubLinks],
  );

  const onGithubFiled = useCallback((link: GithubIssueLink) => {
    setGithubLinks((prev) => {
      const next = new Map(prev);
      next.set(githubLinkKey(link.sourceKind, link.sourceId), link);
      return next;
    });
  }, []);

  const onJiraFiled = useCallback((link: JiraIssueLink) => {
    setJiraLinks((prev) => {
      const next = new Map(prev);
      next.set(jiraLinkKey(link.sourceKind, link.sourceId), link);
      return next;
    });
  }, []);

  const onLinearFiled = useCallback((link: LinearIssueLink) => {
    setLinearLinks((prev) => {
      const next = new Map(prev);
      next.set(linearLinkKey(link.sourceKind, link.sourceId), link);
      return next;
    });
  }, []);

  const value = useMemo<IssueFilingValue>(() => {
    const filableTrackers: IssueTracker[] = [];
    if (jiraIntegration && canFileJira) filableTrackers.push("jira");
    if (linearIntegration && canFileLinear) filableTrackers.push("linear");
    // Offered whenever filing is switched on, even before an installation
    // has approved the `issues` permission: the modal then explains how to
    // grant it, which is more useful than a button that never appears.
    if (githubStatus?.settings.enabled && canFileGithub) filableTrackers.push("github");
    return {
      orgId,
      api,
      openExternal,
      jiraIntegration,
      linearIntegration,
      githubStatus,
      canOpenPullRequests: Boolean(githubStatus?.settings.pullRequestsEnabled && canFileGithub),
      filableTrackers,
      linksFor,
      onJiraFiled,
      onLinearFiled,
      onGithubFiled,
    };
  }, [
    orgId,
    api,
    openExternal,
    jiraIntegration,
    linearIntegration,
    canFileJira,
    canFileLinear,
    githubStatus,
    canFileGithub,
    linksFor,
    onJiraFiled,
    onLinearFiled,
    onGithubFiled,
  ]);

  return <IssueFilingContext.Provider value={value}>{children}</IssueFilingContext.Provider>;
}

/**
 * The filing context, or `null` where no provider is mounted.
 *
 * Deliberately nullable rather than throwing: the findings sections render on
 * surfaces that predate this feature and on hosts that may never wire it up,
 * and the correct behaviour there is "no button", not a crash.
 */
export function useIssueFiling(): IssueFilingValue | null {
  return useContext(IssueFilingContext);
}
