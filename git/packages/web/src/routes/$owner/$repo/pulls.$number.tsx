import { Outlet, createFileRoute } from "@tanstack/react-router";
import { PullLayout } from "../../../features/pulls/PullLayout";

function PullLayoutRoute() {
  const { number } = Route.useParams();
  return (
    <PullLayout key={number} number={Number(number)}>
      <Outlet />
    </PullLayout>
  );
}

export const Route = createFileRoute("/$owner/$repo/pulls/$number")({ component: PullLayoutRoute });
