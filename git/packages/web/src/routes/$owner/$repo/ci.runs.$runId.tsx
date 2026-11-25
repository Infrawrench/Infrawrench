import { createFileRoute } from "@tanstack/react-router";
import { RunPage } from "../../../features/ci/RunPage";

function RunPageRoute() {
  const { runId } = Route.useParams();
  const { job } = Route.useSearch();
  return <RunPage key={runId} runId={runId} job={job} />;
}

export const Route = createFileRoute("/$owner/$repo/ci/runs/$runId")({
  component: RunPageRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    job: search.job === undefined ? undefined : String(search.job),
  }),
});
