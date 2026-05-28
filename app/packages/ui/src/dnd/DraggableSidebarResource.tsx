import { useDraggable, useDroppable, useDndContext } from "@dnd-kit/core";
import type { DraggableResource } from "./types.js";

export interface DraggableSidebarResourceProps {
  resource: DraggableResource;
  isActive?: boolean | undefined;
  onClick: () => void;
  /** Extra data attached to the dnd-kit draggable (e.g. workspaceTabTarget) */
  extraDragData?: Record<string, unknown> | undefined;
  /** Accept drops (for secret import / SSH tunnel on desktop) */
  droppable?: boolean | undefined;
  droppableId?: string | undefined;
  isDropDisabled?: boolean | undefined;
}

export function DraggableSidebarResource({
  resource,
  isActive,
  onClick,
  extraDragData,
  droppable,
  droppableId,
  isDropDisabled,
}: DraggableSidebarResourceProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `sidebar-resource:${resource.id}`,
    data: {
      resource,
      dragLabel: resource.displayName,
      ...extraDragData,
    },
  });

  const { active } = useDndContext();
  const activeResource = active?.data.current?.resource as DraggableResource | undefined;
  const sameAccount = activeResource?.accountId === resource.accountId;
  const secretDropOk = !!droppable && !sameAccount && !isDropDisabled;
  const attachMatch = activeResource?.attachTargets?.find(
    (t) => t.pluginId === resource.pluginId && t.resourceTypeId === resource.resourceTypeId,
  );
  const attachDropOk =
    !!sameAccount &&
    !!attachMatch &&
    activeResource?.id !== resource.id &&
    (!attachMatch.matchField ||
      String(activeResource?.fields?.[attachMatch.matchField] ?? "") ===
        String(resource.fields[attachMatch.matchField] ?? ""));
  // Tunnel → SSH host: account-independent (the tunnel and host usually live in
  // different provider accounts).
  const tunnelAttachDropOk =
    !!activeResource?.isTunnelSshSource &&
    !!resource.isSshHost &&
    activeResource?.id !== resource.id;
  const isDropTarget = secretDropOk || attachDropOk || tunnelAttachDropOk;
  const effectiveDroppableId = tunnelAttachDropOk
    ? `tunnel-ssh-attach:${resource.id}`
    : attachDropOk
      ? `attach-target:${resource.id}`
      : (droppableId ?? `sidebar-resource:${resource.id}`);

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: effectiveDroppableId,
    disabled: !isDropTarget,
    ...(attachDropOk || tunnelAttachDropOk ? { data: { target: resource } } : {}),
  });

  const showDropHint = isOver && isDropTarget && !isDragging;
  const dropHintLabel = tunnelAttachDropOk
    ? "Set up SSH tunnel"
    : attachDropOk
      ? (attachMatch?.verb ?? "Attach")
      : "Drop";

  return (
    <div ref={setDropRef}>
      <button
        type="button"
        ref={setDragRef}
        {...listeners}
        {...attributes}
        onClick={onClick}
        className={`flex items-center gap-2 px-3 py-1 text-xs rounded cursor-grab active:cursor-grabbing transition-colors w-full text-left ${
          showDropHint
            ? "bg-accent-muted text-accent-on-muted ring-1 ring-inset ring-blue-500"
            : isActive
              ? "bg-surface-overlay text-on-surface-secondary"
              : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay"
        } ${isDragging ? "opacity-40" : ""}`}
      >
        <span className="text-on-surface-faint">&#9783;</span>
        <span className="truncate flex-1">{resource.displayName}</span>
        {showDropHint && <span className="text-xs text-accent">{dropHintLabel}</span>}
      </button>
    </div>
  );
}
