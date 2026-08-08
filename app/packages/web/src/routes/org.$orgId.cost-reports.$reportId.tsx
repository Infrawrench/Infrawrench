import { createFileRoute } from "@tanstack/react-router";

// One report's detail view — same workspace tab as the list, which is why this
// route only claims the URL (see WorkspaceTabsViewport).
export const Route = createFileRoute("/org/$orgId/cost-reports/$reportId")({
  component: () => null,
});
