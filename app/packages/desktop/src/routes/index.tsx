import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { getDb } from "../db/client";
import { useUIStore } from "@infrawrench/ui";
import { getWorkspaceNavigateArgs } from "../lib/workspace-tabs";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  const navigate = useNavigate();
  const bumpDashboardPins = useUIStore((s) => s.bumpDashboardPins);
  const tabsHydrated = useUIStore((s) => s.tabsHydrated);
  const workspaceTabs = useUIStore((s) => s.workspaceTabs);
  const activeWorkspaceTabId = useUIStore((s) => s.activeWorkspaceTabId);

  useEffect(() => {
    if (!tabsHydrated) return;
    let cancelled = false;
    async function redirect() {
      try {
        const activeTab = workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? workspaceTabs[0];
        if (activeTab) {
          navigate({ ...getWorkspaceNavigateArgs(activeTab.target), replace: true });
          return;
        }
        const db = await getDb();
        const rows = await db.select<{ id: string }[]>(
          "SELECT id FROM dashboards WHERE is_default = 1 LIMIT 1",
        );
        if (cancelled) return;
        let homeId: string;
        if (rows[0]) {
          homeId = rows[0].id;
        } else {
          // Fixed ID so concurrent StrictMode double-effect runs don't create duplicates
          homeId = "dashboard-home";
          try {
            await db.execute(
              "INSERT INTO dashboards (id, name, is_default) VALUES ($1, $2, 1)",
              [homeId, "Home"],
            );
            bumpDashboardPins();
          } catch {
            // Already exists (e.g. from the parallel StrictMode run) — find the real id
            const existing = await db.select<{ id: string }[]>(
              "SELECT id FROM dashboards WHERE is_default = 1 LIMIT 1",
            );
            homeId = existing[0]?.id ?? homeId;
          }
        }
        if (!cancelled) {
          navigate({ to: "/dashboard/$dashboardId", params: { dashboardId: homeId }, replace: true });
        }
      } catch {
        // If DB fails, just stay on the loading screen
      }
    }
    void redirect();
    return () => { cancelled = true; };
  }, [activeWorkspaceTabId, navigate, tabsHydrated, workspaceTabs]);

  return (
    <div className="flex items-center justify-center h-full text-gray-600 text-sm">
      Loading…
    </div>
  );
}
