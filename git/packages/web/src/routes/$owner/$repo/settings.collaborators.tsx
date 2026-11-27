import { createFileRoute } from "@tanstack/react-router";
import { CollaboratorsPage } from "../../../features/repo-settings/CollaboratorsPage";

export const Route = createFileRoute("/$owner/$repo/settings/collaborators")({
  component: CollaboratorsPage,
});
