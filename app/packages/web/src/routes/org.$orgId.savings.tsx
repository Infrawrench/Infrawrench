import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Potential savings used to be its own page; it is now a section of Costs.
 * The route is kept as a redirect so existing bookmarks and links land on the
 * content rather than a 404.
 */
export const Route = createFileRoute("/org/$orgId/savings")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/org/$orgId/costs", params: { orgId: params.orgId }, replace: true });
  },
});
