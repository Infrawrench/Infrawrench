import { useMemo, type ReactNode } from "react";
import { IssueFilingProvider } from "@infrawrench/ui";
import { PermissionsProvider, usePermissions } from "@/auth/permissions-context";
import { apiGet, apiPost } from "@/lib/api";

/**
 * Every org-scoped React context the authenticated shell provides.
 *
 * Mounted by `__root.tsx` **above both** the workspace-tab viewport and the
 * `<Outlet />`, and that placement is the whole point. A tab's panel is drawn
 * by `WebWorkspaceTabsViewport`, which is a *sibling* of the outlet, so a
 * provider mounted by the `/org/$orgId` layout route covers the route-rendered
 * pages (Settings, Moment) and nothing in a tab — which is most of the app.
 * That gap is what made "File in Jira" / "File in Linear" and the already-filed
 * badges invisible everywhere on web while the identical UI worked on desktop,
 * and what had three tab panels re-reading `/team/me` for themselves instead of
 * using the permissions context. Hoisting is preferred over mounting a second
 * copy inside the viewport because the filing provider batches: one instance
 * loads each tracker's integration and every filed link once for the whole
 * shell.
 *
 * Desktop arrives at the same arrangement from the other side: there the
 * viewport *is* the shell, so `DesktopWorkspaceTabsViewport` mounts the filing
 * provider itself.
 *
 * Anything org-scoped a workspace tab could want goes here, not in the layout
 * route.
 */
export function OrgProviders({ orgId, children }: { orgId: string | null; children: ReactNode }) {
  // No org (the shell rendering while a redirect to /org/:orgId is in flight):
  // render bare rather than provide contexts scoped to nothing. `usePermissions`
  // throws without a provider, which is the honest answer — every consumer is
  // inside an org route.
  if (!orgId) return <>{children}</>;

  return (
    <PermissionsProvider orgId={orgId}>
      <IssueFiling orgId={orgId}>{children}</IssueFiling>
    </PermissionsProvider>
  );
}

/**
 * Bind the shared issue-filing provider to web's transport and permissions.
 *
 * Mounted once for the shell rather than per page because the provider
 * batches: it loads each connected tracker's integration and every filed issue
 * link once, and each findings row then resolves itself from that. Mounting it
 * per section would turn one handful of requests into a handful per section.
 *
 * Inside `PermissionsProvider` because it needs `has()` — the provider skips a
 * tracker's reads entirely without that tracker's `:read`.
 */
function IssueFiling({ orgId, children }: { orgId: string; children: ReactNode }) {
  const { has } = usePermissions();
  // Stable identity: the provider's loading effects depend on `api`, so a new
  // object each render would refetch forever.
  const api = useMemo(() => ({ get: apiGet, post: apiPost }), []);

  return (
    <IssueFilingProvider
      orgId={orgId}
      api={api}
      canReadJira={has("jira:read")}
      canFileJira={has("jira:write")}
      canReadLinear={has("linear:read")}
      canFileLinear={has("linear:write")}
      openExternal={(url) => window.open(url, "_blank", "noopener,noreferrer")}
    >
      {children}
    </IssueFilingProvider>
  );
}
