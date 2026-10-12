import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/compliance")({
  // `?framework=<id>` is which framework the tab is on. Rendering happens in
  // WorkspaceTabsViewport (the tab stays mounted), so this is URL-only. The
  // search is a whitelist: an unlisted key would be dropped on navigation.
  validateSearch: (search: Record<string, unknown>): { framework?: string } => {
    const framework = typeof search["framework"] === "string" ? search["framework"] : undefined;
    return framework ? { framework } : {};
  },
  component: () => null,
});
