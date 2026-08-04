import { createFileRoute } from "@tanstack/react-router";

// Metric alert rules render as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/metric-alerts")({ component: () => null });
