import { createFileRoute } from "@tanstack/react-router";
import { BranchPageView } from "../../../features/branch-page/BranchPageView";
import { parseBranchSearch } from "../../../features/review/branch";

function BranchPageRoute() {
  const { _splat } = Route.useParams();
  const { v, diff, tab } = Route.useSearch();
  const key = _splat ?? "";
  return <BranchPageView key={key} branchKey={key} tab={tab} v={v} diff={diff} />;
}

/** A branch's page: the splat is its key, slashes and all (`feature/a`, `bob/infra:feature/a`). */
export const Route = createFileRoute("/$owner/$repo/branches/$")({
  component: BranchPageRoute,
  validateSearch: parseBranchSearch,
});
