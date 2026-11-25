import { createFileRoute } from "@tanstack/react-router";
import { BlamePage } from "../../../features/code/BlamePage";
import { RefRoute } from "../../../features/code/shared";

function BlameRoute() {
  const { _splat } = Route.useParams();
  return (
    <RefRoute splat={_splat}>
      {({ ref, path }) => <BlamePage key={`${ref}:${path}`} refName={ref} path={path} />}
    </RefRoute>
  );
}

export const Route = createFileRoute("/$owner/$repo/blame/$")({ component: BlameRoute });
