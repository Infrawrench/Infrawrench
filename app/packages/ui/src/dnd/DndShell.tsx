import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { DraggableResource, DraggableWorkflow } from "./types.js";

export interface DndShellProps {
  children: React.ReactNode;
  /** Called when a resource is dropped onto a dashboard target */
  onPinToDashboard?: (resource: DraggableResource, dashboardId: string) => Promise<void> | void;
  /** Called when a workflow is dropped onto a dashboard target */
  onPinWorkflowToDashboard?: (
    workflow: DraggableWorkflow,
    dashboardId: string,
  ) => Promise<void> | void;
  /** Called when a resource is dropped onto a sidebar account/resource (desktop: secret import) */
  onSecretDrop?: (
    source: DraggableResource,
    targetId: string,
    kind: "account" | "resource",
  ) => void;
  /** Called when a resource is dropped onto another resource of the same account to attach it */
  onResourceAttach?: (source: DraggableResource, target: DraggableResource) => void;
  /** Called when an SSH-tunnel source (e.g. Cloudflare Tunnel) is dropped onto an SSH host */
  onTunnelSshAttach?: (tunnel: DraggableResource, host: DraggableResource) => void;
  /** Called for tab bar drops (desktop: tab reorder/pin) */
  onTabDrop?: (event: DragEndEvent) => void;
}

export function DndShell({
  children,
  onPinToDashboard,
  onPinWorkflowToDashboard,
  onSecretDrop,
  onResourceAttach,
  onTunnelSshAttach,
  onTabDrop,
}: DndShellProps) {
  const [dragPreview, setDragPreview] = useState<string | null>(null);
  // Keyboard: dnd-kit's attributes/listeners spreads already make draggables
  // focusable buttons; the KeyboardSensor lets Space/Enter lift and arrow keys
  // move them. Activation constraints stay on the pointer sensor only.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
    const workflow = data?.workflow as DraggableWorkflow | undefined;

    // Dashboard card reorder — both active and over are cards within the grid.
    // Ids are `dashboard-card:<kind>:<id>`; the host resolves them against its
    // merged card list (see `card-order.ts`).
    if (String(active.id).startsWith("dashboard-card:") && overId.startsWith("dashboard-card:")) {
      const activeCardId = String(active.id).replace("dashboard-card:", "");
      const overCardId = overId.replace("dashboard-card:", "");
      if (activeCardId !== overCardId) {
        window.dispatchEvent(
          new CustomEvent("iw:dashboard-card-reorder", {
            detail: { activeCardId, overCardId },
          }),
        );
      }
      return;
    }

    // Tab bar drops — delegate entirely to host
    if (overId === "global-tabs-bar" || overId.startsWith("global-tab:")) {
      onTabDrop?.(event);
      return;
    }

    // Secret import drops — handled by PeerPaneView directly
    if (overId.startsWith("secret-import:")) return;

    // Tunnel → SSH host drops — cross-account; orchestrated by the host
    if (overId.startsWith("tunnel-ssh-attach:")) {
      if (!resource) return;
      const target = over.data.current?.target as DraggableResource | undefined;
      if (!target || resource.id === target.id) return;
      onTunnelSshAttach?.(resource, target);
      return;
    }

    // Attach drops — dragging a resource onto a same-account target resource
    if (overId.startsWith("attach-target:")) {
      if (!resource) return;
      const target = over.data.current?.target as DraggableResource | undefined;
      if (!target || resource.id === target.id) return;
      onResourceAttach?.(resource, target);
      return;
    }

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

    // Dashboard drops — pin a resource or a workflow
    let dashboardId: string | null = null;
    if (overId.startsWith("sidebar-dashboard:")) {
      dashboardId = overId.replace("sidebar-dashboard:", "");
    } else if (overId.startsWith("dashboard:")) {
      dashboardId = overId.replace("dashboard:", "");
    }
    if (!dashboardId) return;

    if (workflow) {
      void onPinWorkflowToDashboard?.(workflow, dashboardId);
      return;
    }
    if (resource) void onPinToDashboard?.(resource, dashboardId);
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
          <div className="px-3 py-1.5 rounded-full border border-blue-500 bg-surface-raised text-sm font-medium text-on-surface-secondary shadow-lg cursor-grabbing opacity-90">
            {dragPreview}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
