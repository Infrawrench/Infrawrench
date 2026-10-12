import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/services")({
  // `?service=<id>` is which service's detail the tab is on, `?view=scorecards`
  // the scorecards view. Rendering happens in WorkspaceTabsViewport (the tab
  // stays mounted), so this is URL-only. `validateSearch` is a whitelist: a
  // key missing here is dropped from the URL on navigation.
  validateSearch: (search: Record<string, unknown>): { service?: string; view?: "scorecards" } => {
    const service = typeof search["service"] === "string" ? search["service"] : undefined;
    if (service) return { service };
    return search["view"] === "scorecards" ? { view: "scorecards" } : {};
  },
  component: () => null,
});
