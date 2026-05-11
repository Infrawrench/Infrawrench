import { createFileRoute, Outlet } from "@tanstack/react-router";
import { PermissionsProvider } from "@/auth/permissions-context";

export const Route = createFileRoute("/org/$orgId")({
  component: OrgLayout,
});

/**
 * Layout route for org-scoped pages. Provides per-org permission state to
 * descendants via PermissionsProvider.
 */
function OrgLayout() {
  const { orgId } = Route.useParams();
  return (
    <PermissionsProvider orgId={orgId}>
      <Outlet />
    </PermissionsProvider>
  );
}
