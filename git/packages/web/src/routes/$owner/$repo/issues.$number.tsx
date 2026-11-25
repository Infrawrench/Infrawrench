import { createFileRoute } from "@tanstack/react-router";
import { IssuePage } from "../../../features/issues/IssuePage";

function IssuePageRoute() {
  const { number } = Route.useParams();
  return <IssuePage key={number} number={Number(number)} />;
}

export const Route = createFileRoute("/$owner/$repo/issues/$number")({ component: IssuePageRoute });
