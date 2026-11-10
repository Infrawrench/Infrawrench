import { createFileRoute, redirect } from "@tanstack/react-router";

// The organization's landing page is Home, the grid of products, which is a
// workspace tab like every other org-level page. The caller's default
// dashboard, which used to be drawn here, is one click away on Home and in
// the sidebar's Dashboards list.
export const Route = createFileRoute("/org/$orgId/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/org/$orgId/home", params: { orgId: params.orgId }, replace: true });
  },
});
