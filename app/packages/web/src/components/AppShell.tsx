"use client";

import { useRouter } from "next/navigation";
import { DndShell, useUIStore, type DraggableResource } from "@infrawrench/ui";
import { pinResourceToDashboard } from "@/actions/dashboard";
import { WebSidebar } from "./WebSidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  async function handlePinToDashboard(resource: DraggableResource, dashboardId: string) {
    await pinResourceToDashboard({ dashboardId, resourceId: resource.id });
    useUIStore.getState().bumpDashboardPins();
    router.refresh();
  }

  return (
    <DndShell onPinToDashboard={handlePinToDashboard}>
      <div className="flex h-screen bg-gray-950 text-gray-100">
        <WebSidebar />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </DndShell>
  );
}
