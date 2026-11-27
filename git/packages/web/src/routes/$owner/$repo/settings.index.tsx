import { createFileRoute } from "@tanstack/react-router";
import { GeneralPage } from "../../../features/repo-settings/GeneralPage";

export const Route = createFileRoute("/$owner/$repo/settings/")({ component: GeneralPage });
