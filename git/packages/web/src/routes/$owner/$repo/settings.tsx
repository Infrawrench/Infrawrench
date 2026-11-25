import { Outlet, createFileRoute } from "@tanstack/react-router";
import { RepoSettingsLayout } from "../../../features/repo-settings/RepoSettingsLayout";

function RepoSettingsLayoutRoute() {
  return (
    <RepoSettingsLayout>
      <Outlet />
    </RepoSettingsLayout>
  );
}

export const Route = createFileRoute("/$owner/$repo/settings")({
  component: RepoSettingsLayoutRoute,
});
