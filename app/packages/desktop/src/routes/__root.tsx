import { useState } from "react";
import { createRootRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { useUIStore } from "@infrawrench/ui";
import { AddAccountModal } from "../components/AddAccountModal";
import { SidebarAccounts } from "../components/SidebarAccounts";
import { SidebarDashboards } from "../components/SidebarDashboards";
import { getDb } from "../db/client";
import { pinResource, type DraggableResource } from "../lib/pins";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const { sidebarCollapsed, toggleSidebar, bumpDashboardPins } = useUIStore();
  const navigate = useNavigate();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [accountsKey, setAccountsKey] = useState(0);
  const [draggingResource, setDraggingResource] = useState<DraggableResource | null>(null);

  async function handleDragEnd(event: DragEndEvent) {
    setDraggingResource(null);
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    if (!overId.startsWith("dashboard:")) return;
    const dashboardId = overId.replace("dashboard:", "");
    const resource = active.data.current?.resource as DraggableResource | undefined;
    if (!resource) return;
    const db = await getDb();
    await pinResource(resource, db, dashboardId);
    bumpDashboardPins();
    void navigate({ to: "/dashboard/$dashboardId", params: { dashboardId } });
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e) => {
        const resource = e.active.data.current?.resource as DraggableResource | undefined;
        setDraggingResource(resource ?? null);
      }}
      onDragEnd={(e) => { void handleDragEnd(e); }}
      onDragCancel={() => setDraggingResource(null)}
    >
      <div className="flex flex-col h-screen bg-gray-950 text-gray-100 select-none">
        {/* macOS title bar — full-width drag region that clears the traffic lights */}
        <div
          className="h-8 flex-shrink-0 border-b border-gray-800/50"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        />

        <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {!sidebarCollapsed && (
          <aside className="w-60 border-r border-gray-800 flex flex-col overflow-hidden flex-shrink-0">
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
              <span className="text-sm font-semibold text-gray-300">Infrawrench</span>
              <button
                onClick={toggleSidebar}
                className="text-gray-700 hover:text-gray-400 transition-colors text-xs"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                aria-label="Collapse sidebar"
              >
                ◀
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-2">
              <SidebarDashboards />
              <SidebarAccounts refreshKey={accountsKey} />
            </div>

            {/* Add account button pinned to the bottom */}
            <div className="border-t border-gray-800 p-2">
              <button
                onClick={() => setShowAddAccount(true)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
              >
                <span className="text-base leading-none">+</span>
                Add account
              </button>
            </div>
          </aside>
        )}

        {/* Expand toggle when collapsed */}
        {sidebarCollapsed && (
          <button
            onClick={toggleSidebar}
            className="w-8 border-r border-gray-800 flex items-center justify-center text-gray-700 hover:text-gray-400 transition-colors flex-shrink-0"
            aria-label="Expand sidebar"
          >
            ▶
          </button>
        )}

        {/* Main content */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>

        {/* Add account modal */}
        {showAddAccount && (
          <AddAccountModal
            onClose={() => setShowAddAccount(false)}
            onAdded={() => setAccountsKey((k) => k + 1)}
          />
        )}
        </div>{/* end flex row */}
      </div>

      {/* Floating drag preview */}
      <DragOverlay>
        {draggingResource && (
          <div className="px-3 py-1.5 rounded-full border border-blue-500 bg-gray-900 text-sm font-medium text-gray-200 shadow-lg cursor-grabbing opacity-90">
            {draggingResource.displayName}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
