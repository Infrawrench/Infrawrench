import { createFileRoute } from "@tanstack/react-router";
import { BranchesTab } from "../../../features/branch-page/BranchesTab";

function BranchesRoute() {
  const { q, view } = Route.useSearch();
  return <BranchesTab q={q} view={view} />;
}

export const Route = createFileRoute("/$owner/$repo/branches/")({
  component: BranchesRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    q: search.q === undefined ? undefined : String(search.q),
    view: search.view === "all" ? ("all" as const) : undefined,
  }),
});
