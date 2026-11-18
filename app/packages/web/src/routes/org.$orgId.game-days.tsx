import { createFileRoute } from "@tanstack/react-router";

// Game days render as a workspace tab (see WorkspaceTabsViewport); this route
// only claims the URL.
export const Route = createFileRoute("/org/$orgId/game-days")({ component: () => null });
