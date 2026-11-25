import { createFileRoute } from "@tanstack/react-router";
import { RefRoute } from "../../../features/code/shared";
import { TreePage } from "../../../features/code/TreePage";

function TreeRoute() {
  const { _splat } = Route.useParams();
  return (
    <RefRoute splat={_splat}>{({ ref, path }) => <TreePage refName={ref} path={path} />}</RefRoute>
  );
}

export const Route = createFileRoute("/$owner/$repo/tree/$")({ component: TreeRoute });
