import { createFileRoute } from "@tanstack/react-router";
import { MilestonePage } from "../../../features/milestones/MilestonesPage";

function MilestonePageRoute() {
  const { number } = Route.useParams();
  return <MilestonePage key={number} number={Number(number)} />;
}

export const Route = createFileRoute("/$owner/$repo/issues/milestones/$number")({
  component: MilestonePageRoute,
});
