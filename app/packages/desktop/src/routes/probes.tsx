import { createFileRoute } from "@tanstack/react-router";

// Synthetic probes render as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/probes")({ component: () => null });
