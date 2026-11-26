import { createFileRoute } from "@tanstack/react-router";
import { MovedRedirect } from "../../../features/branch-page/redirects";

/** The old list's address: the Branches tab, its search kept. */
export const Route = createFileRoute("/$owner/$repo/pulls/")({
  component: () => <MovedRedirect to="list" />,
});
