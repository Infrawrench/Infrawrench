import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Potential savings is a section of Costs, not a page of its own.
 * The route is kept as a redirect so existing bookmarks and links land on the
 * content rather than a 404.
 */
export const Route = createFileRoute("/org/$orgId/savings")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/org/$orgId/costs", params: { orgId: params.orgId }, replace: true });
  },
});
