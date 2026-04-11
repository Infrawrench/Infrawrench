import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/org/$orgId")({
  component: OrgLayout,
});

/**
 * Layout route for org-scoped pages.
 * All child routes can access orgId via Route.useParams().
 */
function OrgLayout() {
  return <Outlet />;
}
