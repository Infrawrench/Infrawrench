import { createFileRoute } from "@tanstack/react-router";
import { PullsPage } from "../../../features/pulls/PullsPage";

function PullsPageRoute() {
  const { q } = Route.useSearch();
  return <PullsPage q={q} />;
}

export const Route = createFileRoute("/$owner/$repo/pulls/")({
  component: PullsPageRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    q: search.q === undefined ? undefined : String(search.q),
  }),
});
