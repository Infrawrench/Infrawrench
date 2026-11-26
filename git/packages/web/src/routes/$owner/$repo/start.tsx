import { createFileRoute } from "@tanstack/react-router";
import { StartWorkPage } from "../../../features/review/StartWorkPage";

export const Route = createFileRoute("/$owner/$repo/start")({ component: StartWorkPage });
