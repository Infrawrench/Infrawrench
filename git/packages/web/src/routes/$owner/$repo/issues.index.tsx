import { createFileRoute } from "@tanstack/react-router";
import { IssuesPage } from "../../../features/issues/IssuesPage";

function IssuesPageRoute() {
  const { q } = Route.useSearch();
  return <IssuesPage q={q} />;
}

export const Route = createFileRoute("/$owner/$repo/issues/")({
  component: IssuesPageRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    q: search.q === undefined ? undefined : String(search.q),
  }),
});
