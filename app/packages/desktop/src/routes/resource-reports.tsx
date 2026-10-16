import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/resource-reports")({
  // `?report=<id>` is which report the tab is on. Rendering happens in
  // WorkspaceTabsViewport (the tab stays mounted), so this is URL-only.
  validateSearch: (search: Record<string, unknown>): { report?: string } => {
    const report = typeof search["report"] === "string" ? search["report"] : undefined;
    return report ? { report } : {};
  },
  component: () => null,
});
