import { createFileRoute } from "@tanstack/react-router";

// Compliance renders as a workspace tab (see WorkspaceTabsViewport); this
// route only claims the URL.
export const Route = createFileRoute("/org/$orgId/compliance")({ component: () => null });
