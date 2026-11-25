import { Outlet, createFileRoute } from "@tanstack/react-router";
import { RepoLayout } from "../../../layout/RepoLayout";

function RepositoryRoute() {
  const { owner, repo } = Route.useParams();
  return (
    <RepoLayout owner={owner} name={repo}>
      <Outlet />
    </RepoLayout>
  );
}

export const Route = createFileRoute("/$owner/$repo")({ component: RepositoryRoute });
