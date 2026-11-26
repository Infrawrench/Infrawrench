import { createFileRoute } from "@tanstack/react-router";
import { PullFiles } from "../../../features/review/PullIndex";

export const Route = createFileRoute("/$owner/$repo/pulls/$number/files")({ component: PullFiles });
