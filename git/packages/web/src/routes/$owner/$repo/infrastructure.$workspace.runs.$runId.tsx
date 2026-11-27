import { createFileRoute } from "@tanstack/react-router";
import { TerraformRunPage } from "../../../features/infrastructure/RunPage";

function TerraformRunPageRoute() {
  const { runId } = Route.useParams();
  return <TerraformRunPage key={runId} runId={runId} />;
}

export const Route = createFileRoute("/$owner/$repo/infrastructure/$workspace/runs/$runId")({
  component: TerraformRunPageRoute,
});
