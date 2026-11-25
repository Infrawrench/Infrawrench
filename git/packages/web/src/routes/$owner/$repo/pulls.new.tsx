import { createFileRoute } from "@tanstack/react-router";
import { NewPullPage } from "../../../features/pulls/NewPullPage";

function NewPullPageRoute() {
  const { base, head } = Route.useSearch();
  return <NewPullPage base={base} head={head} />;
}

export const Route = createFileRoute("/$owner/$repo/pulls/new")({
  component: NewPullPageRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    base: search.base === undefined ? undefined : String(search.base),
    head: search.head === undefined ? undefined : String(search.head),
  }),
});
