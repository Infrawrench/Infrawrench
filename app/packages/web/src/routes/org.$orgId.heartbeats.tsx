import { createFileRoute } from "@tanstack/react-router";

// Heartbeat monitors render as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/heartbeats")({ component: () => null });
