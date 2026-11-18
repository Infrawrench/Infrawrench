import { createFileRoute } from "@tanstack/react-router";

// Migration estimates render as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/migration-estimates")({ component: () => null });
