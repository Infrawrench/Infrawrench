import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/ci")({
  // `?run=<id>` is which run the tab is on. Rendering happens in
  // WorkspaceTabsViewport (the tab stays mounted), so this is URL-only.
  validateSearch: (search: Record<string, unknown>): { run?: string } => {
    const run = typeof search["run"] === "string" ? search["run"] : undefined;
    return run ? { run } : {};
  },
  component: () => null,
});
