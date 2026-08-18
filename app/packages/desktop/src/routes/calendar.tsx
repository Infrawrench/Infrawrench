import { createFileRoute } from "@tanstack/react-router";

// The operations calendar renders as a workspace tab (see
// WorkspaceTabsViewport); this route only claims the URL.
export const Route = createFileRoute("/calendar")({ component: () => null });
