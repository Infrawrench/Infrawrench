import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/slos")({
  // `?slo=<id>` is which SLO's detail the tab is on. Rendering happens in
  // WorkspaceTabsViewport (the tab stays mounted), so this is URL-only.
  validateSearch: (search: Record<string, unknown>): { slo?: string } => {
    const slo = typeof search["slo"] === "string" ? search["slo"] : undefined;
    return slo ? { slo } : {};
  },
  component: () => null,
});
