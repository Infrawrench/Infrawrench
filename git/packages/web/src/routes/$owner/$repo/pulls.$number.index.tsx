import { createFileRoute } from "@tanstack/react-router";
import { NumberRedirect } from "../../../features/branch-page/redirects";

function NumberRoute() {
  const { number } = Route.useParams();
  return <NumberRedirect key={number} number={Number(number)} />;
}

/** An old numbered address: the branch's page, found by its number. */
export const Route = createFileRoute("/$owner/$repo/pulls/$number/")({ component: NumberRoute });
