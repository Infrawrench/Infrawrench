import { createFileRoute } from "@tanstack/react-router";

// Resource reports render as a workspace tab (see WorkspaceTabsViewport); this
// route only claims the URL.
export const Route = createFileRoute("/org/$orgId/resource-reports")({ component: () => null });
