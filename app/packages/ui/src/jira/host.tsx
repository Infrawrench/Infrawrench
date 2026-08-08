import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  indexJiraLinks,
  jiraLinkKey,
  type JiraIntegration,
  type JiraIssueLink,
  type JiraSourceKind,
} from "@infrawrench/client-core";

/**
 * Host-injected transport for the Jira filing affordance. The same two verbs
 * the settings sections use; web wraps `apiFetch`, desktop wraps the cloud IPC
 * proxy, so the components stay platform-agnostic.
 */
export interface JiraFilingApi {
  get<T>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
}

export interface JiraFilingHostProps {
  orgId: string;
  api: JiraFilingApi;
  /** Caller holds `jira:read` — without it there is nothing to fetch. */
  canRead: boolean;
  /** Caller holds `jira:write` — without it the file button never appears. */
  canFile: boolean;
  /** Open the filed issue in a new tab (web) or the system browser (desktop). */
  openExternal: (url: string) => void;
  children: ReactNode;
}

interface JiraFilingValue {
  orgId: string;
  api: JiraFilingApi;
  canFile: boolean;
  openExternal: (url: string) => void;
  /** Null until loaded, and stays null when Jira is not connected. */
  integration: JiraIntegration | null;
  linkFor: (sourceKind: JiraSourceKind, sourceId: string) => JiraIssueLink | undefined;
  onFiled: (link: JiraIssueLink) => void;
}

const JiraFilingContext = createContext<JiraFilingValue | null>(null);

/**
 * Makes "File a Jira issue" available to every findings list underneath it.
 *
 * The provider — not the button — owns the two reads, and that is the point:
 * it fetches the org's integration once and **every** issue link once, so a
 * page showing a hundred findings costs two requests rather than two hundred.
 * Individual buttons then resolve their own state from the in-memory index.
 *
 * Both reads fail soft. A findings page is about findings; if Jira or the
 * database is unreachable the page still renders, just without badges or
 * buttons. The user-initiated create is the opposite — see
 * {@link FileJiraIssueModal}, which surfaces its failures.
 */
export function JiraFilingProvider({
  orgId,
  api,
  canRead,
  canFile,
  openExternal,
  children,
}: JiraFilingHostProps) {
  const [integration, setIntegration] = useState<JiraIntegration | null>(null);
  const [links, setLinks] = useState<Map<string, JiraIssueLink>>(() => new Map());

  useEffect(() => {
    if (!canRead) {
      setIntegration(null);
      setLinks(new Map());
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
        if (!cancelled) setIntegration(res.integration);
      } catch {
        if (!cancelled) setIntegration(null);
      }
    })();
    void (async () => {
      try {
        const rows = await api.get<JiraIssueLink[]>(`/api/org/${orgId}/jira/links`);
        if (!cancelled) setLinks(indexJiraLinks(rows));
      } catch {
        if (!cancelled) setLinks(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId, canRead]);

  const linkFor = useCallback(
    (sourceKind: JiraSourceKind, sourceId: string) => links.get(jiraLinkKey(sourceKind, sourceId)),
    [links],
  );

  const onFiled = useCallback((link: JiraIssueLink) => {
    setLinks((prev) => {
      const next = new Map(prev);
      next.set(jiraLinkKey(link.sourceKind, link.sourceId), link);
      return next;
    });
  }, []);

  const value = useMemo<JiraFilingValue>(
    () => ({ orgId, api, canFile, openExternal, integration, linkFor, onFiled }),
    [orgId, api, canFile, openExternal, integration, linkFor, onFiled],
  );

  return <JiraFilingContext.Provider value={value}>{children}</JiraFilingContext.Provider>;
}

/**
 * The filing context, or `null` where no provider is mounted.
 *
 * Deliberately nullable rather than throwing: the findings sections render on
 * surfaces that predate this feature and on hosts that may never wire it up,
 * and the correct behaviour there is "no button", not a crash.
 */
export function useJiraFiling(): JiraFilingValue | null {
  return useContext(JiraFilingContext);
}
