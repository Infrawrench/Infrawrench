import { createFileRoute } from "@tanstack/react-router";
import { ResourcesTab } from "../../../features/infrastructure/ResourcesTab";

export const Route = createFileRoute("/$owner/$repo/infrastructure/$workspace/resources")({
  component: ResourcesTab,
});
