import { createFileRoute } from "@tanstack/react-router";

// One resource report: same workspace tab as the list, so this route only
// claims the URL (see WorkspaceTabsViewport).
export const Route = createFileRoute("/org/$orgId/resource-reports/$reportId")({
  component: () => null,
});
