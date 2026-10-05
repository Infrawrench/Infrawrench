import { createFileRoute } from "@tanstack/react-router";

// Canvases render as a workspace tab (see WorkspaceTabsViewport); this route
// only claims the URL.
export const Route = createFileRoute("/org/$orgId/cost-canvases")({ component: () => null });
