import { createFileRoute } from "@tanstack/react-router";
import { BlobPage } from "../../../features/code/BlobPage";
import { RefRoute } from "../../../features/code/shared";

function BlobRoute() {
  const { _splat } = Route.useParams();
  return (
    <RefRoute splat={_splat}>
      {({ ref, path }) => <BlobPage key={`${ref}:${path}`} refName={ref} path={path} />}
    </RefRoute>
  );
}

export const Route = createFileRoute("/$owner/$repo/blob/$")({ component: BlobRoute });
