import { createFileRoute } from "@tanstack/react-router";

// Invoices render as a workspace tab (see WorkspaceTabsViewport); this route
// only claims the URL.
export const Route = createFileRoute("/org/$orgId/invoices")({ component: () => null });
