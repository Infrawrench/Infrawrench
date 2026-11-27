import { createFileRoute } from "@tanstack/react-router";
import { ImportPage } from "../../../features/repo-settings/ImportPage";

export const Route = createFileRoute("/$owner/$repo/settings/import")({ component: ImportPage });
