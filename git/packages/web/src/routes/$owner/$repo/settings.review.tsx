import { createFileRoute } from "@tanstack/react-router";
import { ReviewSettingsPage } from "../../../features/repo-settings/ReviewSettingsPage";

export const Route = createFileRoute("/$owner/$repo/settings/review")({
  component: ReviewSettingsPage,
});
