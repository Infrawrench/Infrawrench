import { createFileRoute } from "@tanstack/react-router";
import { BranchesPage } from "../../../features/code/BranchesPage";

export const Route = createFileRoute("/$owner/$repo/branches")({ component: BranchesPage });
