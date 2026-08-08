import { createFileRoute } from "@tanstack/react-router";

// The Domains surface renders as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL.
export const Route = createFileRoute("/dns")({ component: () => null });
