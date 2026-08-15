import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/org/$orgId")({
  component: OrgLayout,
});

/**
 * Layout route for org-scoped pages — a pass-through.
 *
 * The org-scoped contexts (permissions, issue filing) are deliberately *not*
 * here: this route's subtree is only the route-rendered half of the shell, and
 * the other half — every workspace tab — is drawn by the viewport, a sibling of
 * this `<Outlet />`. They are mounted above both in `__root.tsx`; see
 * `components/OrgProviders.tsx`.
 */
function OrgLayout() {
  return <Outlet />;
}
