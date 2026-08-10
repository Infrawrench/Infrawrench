import { createFileRoute } from "@tanstack/react-router";

// The SSH fan-out surface renders as a workspace tab (see
// WorkspaceTabsViewport); this route only claims the URL.
export const Route = createFileRoute("/ssh-fanout")({ component: () => null });
