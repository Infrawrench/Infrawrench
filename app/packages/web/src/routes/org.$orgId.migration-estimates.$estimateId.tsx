import { createFileRoute } from "@tanstack/react-router";

// One migration estimate: same workspace tab as the list, so this route only
// claims the URL (see WorkspaceTabsViewport).
export const Route = createFileRoute("/org/$orgId/migration-estimates/$estimateId")({
  component: () => null,
});
