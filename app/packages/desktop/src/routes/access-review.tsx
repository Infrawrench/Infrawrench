import { createFileRoute } from "@tanstack/react-router";

// The access review renders as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/access-review")({ component: () => null });
