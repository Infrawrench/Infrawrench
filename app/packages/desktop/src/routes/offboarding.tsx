import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/offboarding")({
  // `?offboarding=<id>` is which checklist the tab is on. Rendering happens in
  // WorkspaceTabsViewport (the tab stays mounted), so this is URL-only.
  validateSearch: (search: Record<string, unknown>): { offboarding?: string } => {
    const offboarding =
      typeof search["offboarding"] === "string" ? search["offboarding"] : undefined;
    return offboarding ? { offboarding } : {};
  },
  component: () => null,
});
