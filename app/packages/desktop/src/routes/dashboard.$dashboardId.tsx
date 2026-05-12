import { createFileRoute } from "@tanstack/react-router";
import { DashboardView } from "../components/DashboardView";

export const Route = createFileRoute("/dashboard/$dashboardId")({
  // Rendering is handled by WorkspaceTabsViewport in __root.tsx, which mounts
  // every open tab simultaneously and keeps them alive across tab switches.
  component: () => null,
});

interface DashboardPanelProps {
  dashboardId: string;
}

export function DashboardPanel({ dashboardId }: DashboardPanelProps) {
  return <DashboardView dashboardId={dashboardId} />;
}
