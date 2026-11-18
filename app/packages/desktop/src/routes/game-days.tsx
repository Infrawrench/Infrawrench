import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/game-days")({
  // `?gameDay=<id>` is which game day's report the tab is on. Rendering happens
  // in WorkspaceTabsViewport (the tab stays mounted), so this is URL-only.
  validateSearch: (search: Record<string, unknown>): { gameDay?: string } => {
    const gameDay = typeof search["gameDay"] === "string" ? search["gameDay"] : undefined;
    return gameDay ? { gameDay } : {};
  },
  component: () => null,
});
