import { createFileRoute } from "@tanstack/react-router";
import { CommitsPage } from "../../../features/code/CommitsPage";
import { RefRoute } from "../../../features/code/shared";

function CommitsRoute() {
  const { _splat } = Route.useParams();
  return (
    <RefRoute splat={_splat}>
      {({ ref, path }) => <CommitsPage refName={ref} path={path} />}
    </RefRoute>
  );
}

export const Route = createFileRoute("/$owner/$repo/commits/$")({ component: CommitsRoute });
