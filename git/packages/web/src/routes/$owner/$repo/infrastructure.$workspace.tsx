import { Outlet, createFileRoute } from "@tanstack/react-router";
import { WorkspaceLayout } from "../../../features/infrastructure/WorkspaceLayout";

function WorkspaceLayoutRoute() {
  const { workspace } = Route.useParams();
  return (
    <WorkspaceLayout key={workspace} workspace={workspace}>
      <Outlet />
    </WorkspaceLayout>
  );
}

export const Route = createFileRoute("/$owner/$repo/infrastructure/$workspace")({
  component: WorkspaceLayoutRoute,
});
