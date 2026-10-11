import { createFileRoute } from "@tanstack/react-router";

// Delivery (DORA metrics) renders as a workspace tab (see
// WorkspaceTabsViewport); this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/delivery")({ component: () => null });
