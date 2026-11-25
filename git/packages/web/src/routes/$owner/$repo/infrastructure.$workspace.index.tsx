import { createFileRoute } from "@tanstack/react-router";
import { RunsTab } from "../../../features/infrastructure/RunsTab";

export const Route = createFileRoute("/$owner/$repo/infrastructure/$workspace/")({
  component: RunsTab,
});
