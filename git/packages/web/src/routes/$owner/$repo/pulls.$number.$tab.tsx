import { createFileRoute } from "@tanstack/react-router";
import { NumberRedirect } from "../../../features/branch-page/redirects";

function NumberTabRoute() {
  const { number, tab } = Route.useParams();
  return <NumberRedirect key={`${number}/${tab}`} number={Number(number)} tab={tab} />;
}

/** `/files`, `/commits` and `/checks` of an old numbered address: the same tab of the branch's page. */
export const Route = createFileRoute("/$owner/$repo/pulls/$number/$tab")({
  component: NumberTabRoute,
});
