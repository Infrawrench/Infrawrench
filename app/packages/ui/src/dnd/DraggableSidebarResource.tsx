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
  const isDropTarget = !!droppable && !sameAccount && !isDropDisabled;

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: droppableId ?? `sidebar-resource:${resource.id}`,
    disabled: !isDropTarget,
  });

  const showDropHint = isOver && isDropTarget && !isDragging;

  return (
    <div ref={setDropRef}>
      <button
        ref={setDragRef}
        {...listeners}
        {...attributes}
        onClick={onClick}
        className={`flex items-center gap-2 px-3 py-1 text-xs rounded cursor-grab active:cursor-grabbing transition-colors w-full text-left ${
          showDropHint
            ? "bg-blue-500/20 text-blue-200 ring-1 ring-inset ring-blue-500"
            : isActive
              ? "bg-gray-800 text-gray-200"
              : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
        } ${isDragging ? "opacity-40" : ""}`}
      >
        <span className="text-gray-700">&#9783;</span>
        <span className="truncate flex-1">{resource.displayName}</span>
        {showDropHint && <span className="text-xs text-blue-400">Drop</span>}
      </button>
    </div>
  );
}
