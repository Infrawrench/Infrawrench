import { createFileRoute } from "@tanstack/react-router";
import { TreePage } from "../../../features/code/TreePage";
import { useRepository } from "../../../layout/RepoLayout";

function RepositoryHome() {
  const repository = useRepository();
  return <TreePage refName={repository.defaultBranch} path="" />;
}

export const Route = createFileRoute("/$owner/$repo/")({ component: RepositoryHome });
