import { createFileRoute } from "@tanstack/react-router";
import { DeployKeysPage } from "../../../features/repo-settings/DeployKeysPage";

export const Route = createFileRoute("/$owner/$repo/settings/keys")({ component: DeployKeysPage });
