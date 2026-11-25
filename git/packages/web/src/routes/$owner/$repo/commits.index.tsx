import { createFileRoute } from "@tanstack/react-router";
import { CommitsPage } from "../../../features/code/CommitsPage";
import { useRepository } from "../../../layout/RepoLayout";

function DefaultBranchCommits() {
  const repository = useRepository();
  return <CommitsPage refName={repository.defaultBranch} path="" />;
}

export const Route = createFileRoute("/$owner/$repo/commits/")({
  component: DefaultBranchCommits,
});
