import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { getDb } from "../db/client";
import { useUIStore } from "@infrawrench/ui";
import {
  dashboardTabTarget,
  getWorkspaceNavigateArgs,
  navigateToWorkspaceTarget,
} from "../lib/workspace-tabs";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  const gt = useGT();
  const navigate = useNavigate();
  const bumpDashboardPins = useUIStore((s) => s.bumpDashboardPins);
  const tabsHydrated = useUIStore((s) => s.tabsHydrated);
  const workspaceTabs = useUIStore((s) => s.workspaceTabs);
  const activeWorkspaceTabId = useUIStore((s) => s.activeWorkspaceTabId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tabsHydrated) return;
    let cancelled = false;
    async function redirect() {
      try {
        const activeTab =
          workspaceTabs.find((tab) => tab.id === activeWorkspaceTabId) ?? workspaceTabs[0];
        if (activeTab) {
          navigate({ ...getWorkspaceNavigateArgs(activeTab.target), replace: true });
          return;
        }
        const db = await getDb();
        const rows = await db.select<{ id: string; name: string }[]>(
          "SELECT id, name FROM dashboards WHERE is_default = 1 LIMIT 1",
        );
        if (cancelled) return;
        let homeId: string;
        let homeName = gt("Home");
        if (rows[0]) {
          homeId = rows[0].id;
          homeName = rows[0].name;
        } else {
          // Fixed ID so concurrent StrictMode double-effect runs don't create duplicates
          homeId = "dashboard-home";
          try {
            await db.execute("INSERT INTO dashboards (id, name, is_default) VALUES ($1, $2, 1)", [
              homeId,
              gt("Home"),
            ]);
            bumpDashboardPins();
          } catch {
            // Already exists (e.g. from the parallel StrictMode run) — find the real id
            const existing = await db.select<{ id: string; name: string }[]>(
              "SELECT id, name FROM dashboards WHERE is_default = 1 LIMIT 1",
            );
            homeId = existing[0]?.id ?? homeId;
            homeName = existing[0]?.name ?? homeName;
          }
        }
        if (!cancelled) {
          void navigateToWorkspaceTarget(navigate, dashboardTabTarget(homeId), {
            label: homeName,
            replace: true,
          });
        }
      } catch (err) {
        // Without this the app parks on "Loading…" forever with no clue why.
        console.error("[home] Failed to resolve the default dashboard:", err);
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void redirect();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceTabId, navigate, tabsHydrated, workspaceTabs]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 h-full text-sm px-6 text-center">
        <span className="text-danger font-medium">{gt("Couldn't open your home dashboard")}</span>
        <span className="text-on-surface-faint break-all">{error}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full text-on-surface-faint text-sm">
      {gt("Loading…")}
    </div>
  );
}
