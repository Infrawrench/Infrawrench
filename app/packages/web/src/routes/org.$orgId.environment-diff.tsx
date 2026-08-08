import { createFileRoute } from "@tanstack/react-router";

// The environment diff renders as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL. `?a=`/`?b=` are read back by
// syncWorkspaceRouteFromPath, so they are not validated here.
export const Route = createFileRoute("/org/$orgId/environment-diff")({ component: () => null });
