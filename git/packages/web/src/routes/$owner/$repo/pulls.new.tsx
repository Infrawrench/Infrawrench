import { createFileRoute } from "@tanstack/react-router";
import { MovedRedirect } from "../../../features/branch-page/redirects";

/** The old form to open a page: every branch has one now, so the Branches tab. */
export const Route = createFileRoute("/$owner/$repo/pulls/new")({
  component: () => <MovedRedirect to="branches" />,
});
