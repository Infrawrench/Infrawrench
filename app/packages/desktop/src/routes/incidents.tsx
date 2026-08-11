import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/incidents")({
  // `?incident=<id>` is which incident the tab is on. Rendering happens in
  // WorkspaceTabsViewport (the tab stays mounted), so this is URL-only.
  validateSearch: (search: Record<string, unknown>): { incident?: string } => {
    const incident = typeof search["incident"] === "string" ? search["incident"] : undefined;
    return incident ? { incident } : {};
  },
  component: () => null,
});
