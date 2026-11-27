import { createFileRoute } from "@tanstack/react-router";
import { CommitPage } from "../../../features/code/CommitPage";

function CommitRoute() {
  const { sha } = Route.useParams();
  return <CommitPage key={sha} sha={sha} />;
}

export const Route = createFileRoute("/$owner/$repo/commit/$sha")({ component: CommitRoute });
