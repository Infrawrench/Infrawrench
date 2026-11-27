import { createFileRoute } from "@tanstack/react-router";
import { MilestonesPage } from "../../../features/milestones/MilestonesPage";

export const Route = createFileRoute("/$owner/$repo/issues/milestones/")({
  component: MilestonesPage,
});
