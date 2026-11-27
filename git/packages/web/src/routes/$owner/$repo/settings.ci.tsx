import { createFileRoute } from "@tanstack/react-router";
import { CiSettingsPage } from "../../../features/repo-settings/CiSettingsPage";

export const Route = createFileRoute("/$owner/$repo/settings/ci")({ component: CiSettingsPage });
