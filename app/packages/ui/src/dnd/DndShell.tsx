import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { DraggableResource } from "./types.js";

export interface DndShellProps {
  children: React.ReactNode;
  /** Called when a resource is dropped onto a dashboard target */
  onPinToDashboard?: (resource: DraggableResource, dashboardId: string) => Promise<void> | void;
  /** Called when a resource is dropped onto a sidebar account/resource (desktop: secret import) */
  onSecretDrop?: (
    source: DraggableResource,
    targetId: string,
    kind: "account" | "resource",
  ) => void;
  /** Called for tab bar drops (desktop: tab reorder/pin) */
  onTabDrop?: (event: DragEndEvent) => void;
}

export function DndShell({ children, onPinToDashboard, onSecretDrop, onTabDrop }: DndShellProps) {
  const [dragPreview, setDragPreview] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current;
    const label = (data?.dragLabel as string) ?? (data?.resource as DraggableResource)?.displayName;
    setDragPreview(label ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setDragPreview(null);
    const { active, over } = event;
    if (!over) return;

    const overId = String(over.id);
    const data = active.data.current;
    const resource = data?.resource as DraggableResource | undefined;

    // Tab bar drops — delegate entirely to host
    if (overId === "global-tabs-bar" || overId.startsWith("global-tab:")) {
      onTabDrop?.(event);
      return;
    }

    // Secret import drops — handled by PeerPaneView directly
    if (overId.startsWith("secret-import:")) return;

    // Sidebar account/resource drops — secret import
    if (overId.startsWith("sidebar-account:") || overId.startsWith("sidebar-resource:")) {
      if (!resource) return;
      const targetId = overId.startsWith("sidebar-account:")
        ? overId.replace("sidebar-account:", "")
        : overId.replace("sidebar-resource:", "");
      if (resource.id === targetId) return;
      const kind = overId.startsWith("sidebar-account:")
        ? ("account" as const)
        : ("resource" as const);
      onSecretDrop?.(resource, targetId, kind);
      return;
    }

    // Dashboard drops — pin resource
    let dashboardId: string | null = null;
    if (overId.startsWith("sidebar-dashboard:")) {
      dashboardId = overId.replace("sidebar-dashboard:", "");
    } else if (overId.startsWith("dashboard:")) {
      dashboardId = overId.replace("dashboard:", "");
    }
    if (!dashboardId || !resource) return;

    void onPinToDashboard?.(resource, dashboardId);
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDragPreview(null)}
    >
      {children}

      <DragOverlay>
        {dragPreview && (
          <div className="px-3 py-1.5 rounded-full border border-blue-500 bg-gray-900 text-sm font-medium text-gray-200 shadow-lg cursor-grabbing opacity-90">
            {dragPreview}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
