import { createFileRoute } from "@tanstack/react-router";
import { StateTab } from "../../../features/infrastructure/StateTab";

export const Route = createFileRoute("/$owner/$repo/infrastructure/$workspace/state")({
  component: StateTab,
});
