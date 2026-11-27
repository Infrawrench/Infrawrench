import { createFileRoute } from "@tanstack/react-router";
import { MirrorsPage } from "../../../features/repo-settings/MirrorsPage";

export const Route = createFileRoute("/$owner/$repo/settings/mirrors")({ component: MirrorsPage });
