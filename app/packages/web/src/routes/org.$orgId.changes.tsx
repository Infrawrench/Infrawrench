import { createFileRoute } from "@tanstack/react-router";

// The change timeline renders as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/changes")({ component: () => null });
