import { createFileRoute } from "@tanstack/react-router";

// Posture checks render as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/posture")({ component: () => null });
