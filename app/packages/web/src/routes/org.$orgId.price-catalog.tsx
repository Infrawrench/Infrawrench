import { createFileRoute } from "@tanstack/react-router";

// The price catalog renders as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/price-catalog")({ component: () => null });
