import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { DashboardView } from "@/components/DashboardView";
import { apiGet } from "@/lib/api";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
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
  }, []);

  useEffect(() => {
    function onChanged() {
      apiGet<typeof data>("/api/dashboards/default/full").then(setData);
    }
    window.addEventListener("iw:resources-changed", onChanged);
    return () => window.removeEventListener("iw:resources-changed", onChanged);
  }, []);

  if (!data) return <div className="p-6 text-gray-500 text-sm animate-pulse">Loading…</div>;

  return (
    <DashboardView
      dashboardId={data.dashboard.id}
      dashboardName={data.dashboard.name}
      pins={data.pins}
    />
  );
}
