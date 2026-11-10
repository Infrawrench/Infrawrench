import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { getDb } from "../db/client";
import { useUIStore } from "@infrawrench/ui";
import {
  homeTabTarget,
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
        const rows = await db.select<{ id: string }[]>(
          "SELECT id FROM dashboards WHERE is_default = 1 LIMIT 1",
        );
        if (cancelled) return;
        // Make sure there is a default dashboard: the sidebar, the new
        // pin targets and Home's Dashboards card all expect one to exist.
        if (!rows[0]) {
          try {
            // Fixed ID so concurrent StrictMode double-effect runs don't create duplicates
            await db.execute("INSERT INTO dashboards (id, name, is_default) VALUES ($1, $2, 1)", [
              "dashboard-home",
              gt("Home"),
            ]);
            bumpDashboardPins();
          } catch {
            // Already exists (e.g. from the parallel StrictMode run).
          }
        }
        if (!cancelled) {
          // The default dashboard above is only made sure of; the landing
          // page is Home, the grid of products.
          void navigateToWorkspaceTarget(navigate, homeTabTarget(), { replace: true });
        }
      } catch (err) {
        // Without this the app parks on "Loading…" forever with no clue why.
        console.error("[home] Failed to open Home:", err);
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
        <span className="text-danger font-medium">{gt("Couldn't open Home")}</span>
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
