import { createFileRoute } from "@tanstack/react-router";

// Backup coverage renders as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/org/$orgId/backups")({ component: () => null });
