import { createFileRoute } from "@tanstack/react-router";
import { LabelsSettingsPage } from "../../../features/repo-settings/ThreadSettingsPages";

export const Route = createFileRoute("/$owner/$repo/settings/labels")({
  component: LabelsSettingsPage,
});
