import { createFileRoute } from "@tanstack/react-router";

// Incident mode renders as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/incidents")({ component: () => null });
