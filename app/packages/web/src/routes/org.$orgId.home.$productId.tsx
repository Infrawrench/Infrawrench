import { createFileRoute } from "@tanstack/react-router";

// A product page renders as a workspace tab (see WorkspaceTabsViewport); this route
// only claims the URL.
export const Route = createFileRoute("/org/$orgId/home/$productId")({ component: () => null });
