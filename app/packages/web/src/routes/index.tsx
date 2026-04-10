import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useUIStore, RESOURCES_CHANGED_EVENT } from "@infrawrench/ui";
import { DashboardView } from "@/components/DashboardView";
import { apiGet } from "@/lib/api";
import { dashboardTabTarget } from "@/lib/workspace-tabs";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const dashboardPinsVersion = useUIStore((s) => s.dashboardPinsVersion);
  const [data, setData] = useState<{
    dashboard: { id: string; name: string };
    pins: Array<{
      pinId: string;
      resourceId: string;
      gridX: number;
      gridY: number;
      gridW: number;
      gridH: number;
      displayName: string;
      pluginId: string;
      resourceTypeId: string;
      accountId: string;
      fieldsJson: unknown;
      outputsJson: unknown;
    }>;
  } | null>(null);

  useEffect(() => {
    apiGet<typeof data>("/api/dashboards/default/full").then(setData);
  }, [dashboardPinsVersion]);

  // Sync the active tab to show the default dashboard with its real name
  useEffect(() => {
    if (!data) return;
    const { syncWorkspaceRoute, activeWorkspaceTabId, workspaceTabs } = useUIStore.getState();
    const target = dashboardTabTarget(data.dashboard.id);
    syncWorkspaceRoute(target, data.dashboard.name);
  }, [data]);

  useEffect(() => {
    function onChanged() {
      apiGet<typeof data>("/api/dashboards/default/full").then(setData);
    }
    window.addEventListener(RESOURCES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(RESOURCES_CHANGED_EVENT, onChanged);
  }, []);

  if (!data) return <div className="p-6 text-gray-500 text-sm animate-pulse">Loading…</div>;

  return (
    <DashboardView
      dashboardId={data.dashboard.id}
      dashboardName={data.dashboard.name}
      isHome
      pins={data.pins}
    />
  );
}
