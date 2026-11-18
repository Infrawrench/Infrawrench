import { createFileRoute } from "@tanstack/react-router";

// The price catalog renders as a workspace tab (see WorkspaceTabsViewport);
// this route only claims the URL. `?view=changes` is the Changes view.
// `validateSearch` is a whitelist: a key missing here is dropped from the URL
// on navigation.
export const Route = createFileRoute("/price-catalog")({
  validateSearch: (search: Record<string, unknown>): { view?: "changes" } =>
    search["view"] === "changes" ? { view: "changes" } : {},
  component: () => null,
});
