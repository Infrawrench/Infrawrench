import { createFileRoute } from "@tanstack/react-router";
import { ComparePage } from "../../../features/code/ComparePage";
import { parseCompare } from "../../../lib/refs";

function CompareRoute() {
  const { _splat } = Route.useParams();
  const refs = parseCompare(_splat ?? "");
  return <ComparePage base={refs?.base ?? null} head={refs?.head ?? null} />;
}

export const Route = createFileRoute("/$owner/$repo/compare/$")({ component: CompareRoute });
