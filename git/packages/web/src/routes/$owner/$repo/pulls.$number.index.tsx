import { createFileRoute } from "@tanstack/react-router";
import { parseDiffMode } from "../../../features/review/branch";
import { PullIndex } from "../../../features/review/PullIndex";

function PullIndexRoute() {
  const { v, diff } = Route.useSearch();
  return <PullIndex v={v} diff={diff} />;
}

export const Route = createFileRoute("/$owner/$repo/pulls/$number/")({
  component: PullIndexRoute,
  // The branch page's version and diff. The pull request page reads neither.
  validateSearch: (search: Record<string, unknown>) => {
    const v = Number(search.v);
    return {
      v: Number.isInteger(v) && v > 0 ? v : undefined,
      diff: parseDiffMode(search.diff),
    };
  },
});
