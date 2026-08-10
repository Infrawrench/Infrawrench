import { createFileRoute } from "@tanstack/react-router";

// The Expiry radar renders as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/expiring")({ component: () => null });
