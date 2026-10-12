import { createFileRoute } from "@tanstack/react-router";

// Delivery (DORA metrics) renders in WorkspaceTabsViewport (the tab stays
// mounted), so this route is URL-only.
export const Route = createFileRoute("/delivery")({ component: () => null });
