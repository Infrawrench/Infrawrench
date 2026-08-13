import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/workflows")({
  // `?workflow=<id>` is which workflow the tab is on. Rendering happens in
  // WorkspaceTabsViewport (the tab stays mounted), so this is URL-only.
  validateSearch: (search: Record<string, unknown>): { workflow?: string } => {
    const workflow = typeof search["workflow"] === "string" ? search["workflow"] : undefined;
    return workflow ? { workflow } : {};
  },
  component: () => null,
});
