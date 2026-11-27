import { createFileRoute } from "@tanstack/react-router";
import { SettingsTab } from "../../../features/infrastructure/SettingsTab";

export const Route = createFileRoute("/$owner/$repo/infrastructure/$workspace/settings")({
  component: SettingsTab,
});
