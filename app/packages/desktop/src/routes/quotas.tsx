import { createFileRoute } from "@tanstack/react-router";

// The quota radar renders as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/quotas")({ component: () => null });
