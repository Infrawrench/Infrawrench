import { createFileRoute } from "@tanstack/react-router";

// Infrastructure as Code (IaC reconciliation) renders as a workspace tab
// (see WorkspaceTabsViewport); this route only claims the URL.
export const Route = createFileRoute("/iac")({ component: () => null });
