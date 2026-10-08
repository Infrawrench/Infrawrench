import { createFileRoute } from "@tanstack/react-router";

// Just-in-time access renders as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/jit-access")({ component: () => null });
