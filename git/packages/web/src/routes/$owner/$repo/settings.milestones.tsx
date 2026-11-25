import { createFileRoute } from "@tanstack/react-router";
import { MilestonesSettingsPage } from "../../../features/repo-settings/ThreadSettingsPages";

export const Route = createFileRoute("/$owner/$repo/settings/milestones")({
  component: MilestonesSettingsPage,
});
