import { createFileRoute } from "@tanstack/react-router";

// Environment files render as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/env-files")({ component: () => null });
