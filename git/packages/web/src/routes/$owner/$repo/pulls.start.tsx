import { createFileRoute } from "@tanstack/react-router";
import { MovedRedirect } from "../../../features/branch-page/redirects";

export const Route = createFileRoute("/$owner/$repo/pulls/start")({
  component: () => <MovedRedirect to="start" />,
});
