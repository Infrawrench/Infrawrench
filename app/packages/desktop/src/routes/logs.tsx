import { createFileRoute } from "@tanstack/react-router";

// The Log workspace renders as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/logs")({ component: () => null });
