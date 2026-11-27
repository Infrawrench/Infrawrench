import { createFileRoute } from "@tanstack/react-router";
import { CiPage } from "../../../features/ci/CiPage";

function CiPageRoute() {
  const { branch, status } = Route.useSearch();
  return <CiPage branch={branch} status={status} />;
}

export const Route = createFileRoute("/$owner/$repo/ci/")({
  component: CiPageRoute,
  validateSearch: (search: Record<string, unknown>) => ({
    branch: search.branch === undefined ? undefined : String(search.branch),
    status: search.status === undefined ? undefined : String(search.status),
  }),
});
