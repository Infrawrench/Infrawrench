import { createFileRoute } from "@tanstack/react-router";
import { InfrastructurePage } from "../../../features/infrastructure/InfrastructurePage";

export const Route = createFileRoute("/$owner/$repo/infrastructure/")({
  component: InfrastructurePage,
});
