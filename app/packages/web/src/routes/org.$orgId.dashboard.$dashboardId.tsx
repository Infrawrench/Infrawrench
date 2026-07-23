import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useUIStore, useTabId, RESOURCES_CHANGED_EVENT } from "@infrawrench/ui";
import type { DashboardWidget } from "@infrawrench/ui/cost/config";
import { DashboardView, type WorkflowPin } from "@/components/DashboardView";
import { apiGet } from "@/lib/api";

export const Route = createFileRoute("/org/$orgId/dashboard/$dashboardId")({
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which mounts
  // every open tab simultaneously and keeps them alive across tab switches.
  // The route still matches for URL navigation; the matching tab's panel is
  // what actually renders.
  component: () => null,
});

interface DashboardPanelData {
  dashboard: { id: string; name: string; isDefault: boolean };
  pins: Array<{
    pinId: string;
    resourceId: string;
    gridX: number;
    gridY: number;
    gridW: number;
    gridH: number;
  }>;
  workflowPins?: WorkflowPin[];
  widgets?: DashboardWidget[];
}

interface DashboardPanelProps {
  orgId: string;
  dashboardId: string;
}

export function DashboardPanel({ orgId, dashboardId }: DashboardPanelProps) {
  const dashboardPinsVersion = useUIStore((s) => s.dashboardPinsVersion);
  const tabId = useTabId();
  const [data, setData] = useState<DashboardPanelData | null>(null);

  useEffect(() => {
    apiGet<DashboardPanelData>(`/api/org/${orgId}/dashboards/${dashboardId}`).then(setData);
  }, [orgId, dashboardId, dashboardPinsVersion]);

  useEffect(() => {
    if (!data || !tabId) return;
    useUIStore.getState().setWorkspaceTabTitle(tabId, data.dashboard.name);
  }, [data, tabId]);

  useEffect(() => {
    function onChanged() {
      apiGet<DashboardPanelData>(`/api/org/${orgId}/dashboards/${dashboardId}`).then(setData);
    }
    window.addEventListener(RESOURCES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(RESOURCES_CHANGED_EVENT, onChanged);
  }, [orgId, dashboardId]);

  if (!data) return <div className="p-6 text-on-surface-muted text-sm animate-pulse">Loading…</div>;

  return (
    <DashboardView
      dashboardId={data.dashboard.id}
      dashboardName={data.dashboard.name}
      isHome={data.dashboard.isDefault}
      pins={data.pins}
      workflowPins={data.workflowPins}
      widgets={data.widgets}
    />
  );
}
