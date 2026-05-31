import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useUIStore, RESOURCES_CHANGED_EVENT } from "@infrawrench/ui";
import { DashboardView, type WorkflowPin } from "@/components/DashboardView";
import { apiGet } from "@/lib/api";
import { dashboardTabTarget } from "@/lib/workspace-tabs";

export const Route = createFileRoute("/org/$orgId/")({
  component: HomePage,
});

function HomePage() {
  const { orgId } = Route.useParams();
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
    }>;
    workflowPins?: WorkflowPin[];
  } | null>(null);

  useEffect(() => {
    apiGet<typeof data>(`/api/org/${orgId}/dashboards/default/full`).then(setData);
  }, [orgId, dashboardPinsVersion]);

  useEffect(() => {
    if (!data) return;
    const target = dashboardTabTarget(data.dashboard.id);
    useUIStore.getState().syncWorkspaceRoute(target, data.dashboard.name);
  }, [data]);

  useEffect(() => {
    function onChanged() {
      apiGet<typeof data>(`/api/org/${orgId}/dashboards/default/full`).then(setData);
    }
    window.addEventListener(RESOURCES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(RESOURCES_CHANGED_EVENT, onChanged);
  }, [orgId]);

  if (!data) return <div className="p-6 text-on-surface-muted text-sm animate-pulse">Loading…</div>;

  return (
    <DashboardView
      dashboardId={data.dashboard.id}
      dashboardName={data.dashboard.name}
      isHome
      pins={data.pins}
      workflowPins={data.workflowPins}
    />
  );
}
