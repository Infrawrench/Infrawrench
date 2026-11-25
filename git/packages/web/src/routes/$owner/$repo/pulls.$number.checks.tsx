import { createFileRoute } from "@tanstack/react-router";
import { ChecksTab } from "../../../features/pulls/ChecksTab";

export const Route = createFileRoute("/$owner/$repo/pulls/$number/checks")({
  component: ChecksTab,
});
