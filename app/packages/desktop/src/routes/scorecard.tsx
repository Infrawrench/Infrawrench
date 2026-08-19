import { createFileRoute } from "@tanstack/react-router";

// The scorecard renders as a workspace tab (see WorkspaceTabsViewport); this
// route only claims the URL.
export const Route = createFileRoute("/scorecard")({ component: () => null });
