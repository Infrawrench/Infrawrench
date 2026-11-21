import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/migration-estimates")({
  // `?estimate=<id>` is which estimate the tab is on. Rendering happens in
  // WorkspaceTabsViewport (the tab stays mounted), so this is URL-only.
  validateSearch: (search: Record<string, unknown>): { estimate?: string } => {
    const estimate = typeof search["estimate"] === "string" ? search["estimate"] : undefined;
    return estimate ? { estimate } : {};
  },
  component: () => null,
});
