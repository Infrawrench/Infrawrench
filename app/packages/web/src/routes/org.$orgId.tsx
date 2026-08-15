import { useMemo } from "react";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { IssueFilingProvider } from "@infrawrench/ui";
import { PermissionsProvider, usePermissions } from "@/auth/permissions-context";
import { apiGet, apiPost } from "@/lib/api";

export const Route = createFileRoute("/org/$orgId")({
  component: OrgLayout,
});

/**
 * Layout route for org-scoped pages. Provides per-org permission state to
 * descendants via PermissionsProvider, and the issue-filing context every
 * findings list reads to decide whether it can offer to file into Jira,
 * Linear, or both.
 */
function OrgLayout() {
  const { orgId } = Route.useParams();
  return (
    <PermissionsProvider orgId={orgId}>
      <IssueFiling orgId={orgId}>
        <Outlet />
      </IssueFiling>
    </PermissionsProvider>
  );
}

/**
 * Bind the shared issue-filing provider to web's transport and permissions.
 *
 * Mounted here rather than per page because the provider batches: it loads
 * each connected tracker's integration and every filed issue link once, and
 * each findings row then resolves itself from that. Mounting it per section
 * would turn one handful of requests into a handful per section.
 *
 * Inside `PermissionsProvider` because it needs `has()` — the provider skips
 * a tracker's reads entirely without that tracker's `:read`.
 */
function IssueFiling({ orgId, children }: { orgId: string; children: React.ReactNode }) {
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
