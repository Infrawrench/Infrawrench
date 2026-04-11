import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useUIStore, RESOURCES_CHANGED_EVENT } from "@infrawrench/ui";
import { DashboardView } from "@/components/DashboardView";
import { apiGet } from "@/lib/api";

export const Route = createFileRoute("/org/$orgId/dashboard/$dashboardId")({
  component: DashboardPage,
});

function DashboardPage() {
  const { orgId, dashboardId } = Route.useParams();
  const dashboardPinsVersion = useUIStore((s) => s.dashboardPinsVersion);
  const [data, setData] = useState<{
    dashboard: { id: string; name: string; isDefault: boolean };
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
    apiGet<typeof data>(`/api/org/${orgId}/dashboards/${dashboardId}`).then(setData);
  }, [dashboardId, dashboardPinsVersion]);

  useEffect(() => {
    if (!data) return;
    const { activeWorkspaceTabId, setWorkspaceTabTitle } = useUIStore.getState();
    if (activeWorkspaceTabId) setWorkspaceTabTitle(activeWorkspaceTabId, data.dashboard.name);
  }, [data]);

  useEffect(() => {
    function onChanged() {
      apiGet<typeof data>(`/api/org/${orgId}/dashboards/${dashboardId}`).then(setData);
    }
    window.addEventListener(RESOURCES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(RESOURCES_CHANGED_EVENT, onChanged);
  }, [dashboardId]);

  if (!data) return <div className="p-6 text-gray-500 text-sm animate-pulse">Loading…</div>;

  return (
    <DashboardView
      dashboardId={data.dashboard.id}
      dashboardName={data.dashboard.name}
      isHome={data.dashboard.isDefault}
      pins={data.pins}
    />
  );
}
