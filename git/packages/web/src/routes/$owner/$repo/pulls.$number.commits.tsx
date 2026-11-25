import { createFileRoute } from "@tanstack/react-router";
import { CommitsTab } from "../../../features/pulls/CommitsTab";

export const Route = createFileRoute("/$owner/$repo/pulls/$number/commits")({
  component: CommitsTab,
});
