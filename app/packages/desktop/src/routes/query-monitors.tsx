import { createFileRoute } from "@tanstack/react-router";

// Query monitors render as a workspace tab (see WorkspaceTabsViewport); this
// route only claims the URL.
export const Route = createFileRoute("/query-monitors")({ component: () => null });
