import { useMemo } from "react";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { JiraFilingProvider } from "@infrawrench/ui";
import { PermissionsProvider, usePermissions } from "@/auth/permissions-context";
import { apiGet, apiPost } from "@/lib/api";

export const Route = createFileRoute("/org/$orgId")({
  component: OrgLayout,
});

/**
 * Layout route for org-scoped pages. Provides per-org permission state to
 * descendants via PermissionsProvider, and the Jira filing context every
 * findings list reads to decide whether it can offer "File a Jira issue".
 */
function OrgLayout() {
  const { orgId } = Route.useParams();
  return (
    <PermissionsProvider orgId={orgId}>
      <JiraFiling orgId={orgId}>
        <Outlet />
      </JiraFiling>
    </PermissionsProvider>
  );
}

/**
 * Bind the shared Jira filing provider to web's transport and permissions.
 *
 * Mounted here rather than per page because the provider batches: it loads the
 * org's integration and every filed issue link once, and each findings row
 * then resolves itself from that. Mounting it per section would turn one pair
 * of requests into a pair per section.
 *
 * Inside `PermissionsProvider` because it needs `has()` — the provider skips
 * both reads entirely without `jira:read`.
 */
function JiraFiling({ orgId, children }: { orgId: string; children: React.ReactNode }) {
  const { has } = usePermissions();
  // Stable identity: the provider's loading effect depends on `api`, so a new
  // object each render would refetch forever.
  const api = useMemo(() => ({ get: apiGet, post: apiPost }), []);

  return (
    <JiraFilingProvider
      orgId={orgId}
      api={api}
      canRead={has("jira:read")}
      canFile={has("jira:write")}
      openExternal={(url) => window.open(url, "_blank", "noopener,noreferrer")}
    >
      {children}
    </JiraFilingProvider>
  );
}
