import { Outlet, createFileRoute } from "@tanstack/react-router";
import { SettingsLayout } from "../features/settings/SettingsLayout";

function SettingsLayoutRoute() {
  return (
    <SettingsLayout>
      <Outlet />
    </SettingsLayout>
  );
}

export const Route = createFileRoute("/settings")({ component: SettingsLayoutRoute });
