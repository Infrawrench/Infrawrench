import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useUIStore } from "@infrawrench/ui";
import { DashboardView } from "@/components/DashboardView";
import { apiGet } from "@/lib/api";

export const Route = createFileRoute("/dashboard/$dashboardId")({
  component: DashboardPage,
});

function DashboardPage() {
  const { dashboardId } = Route.useParams();
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
    apiGet<typeof data>(`/api/dashboards/${dashboardId}`).then(setData);
  }, [dashboardId]);

  // Update tab title with real dashboard name
  useEffect(() => {
    if (!data) return;
    const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
    if (activeWorkspaceTabId) setWorkspaceTabTitle(activeWorkspaceTabId, data.dashboard.name);
  }, [data]);

  useEffect(() => {
    function onChanged() {
      apiGet<typeof data>(`/api/dashboards/${dashboardId}`).then(setData);
    }
    window.addEventListener("iw:resources-changed", onChanged);
    return () => window.removeEventListener("iw:resources-changed", onChanged);
  }, [dashboardId]);

  if (!data) return <div className="p-6 text-gray-500 text-sm animate-pulse">Loading…</div>;

  return (
    <DashboardView
      dashboardId={data.dashboard.id}
      dashboardName={data.dashboard.name}
      pins={data.pins}
    />
  );
}
