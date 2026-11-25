import { createFileRoute } from "@tanstack/react-router";
import { BranchesPage } from "../../../features/repo-settings/BranchesPage";

export const Route = createFileRoute("/$owner/$repo/settings/branches")({
  component: BranchesPage,
});
