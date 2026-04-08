import { useDraggable, useDroppable, useDndContext } from "@dnd-kit/core";
import type { DraggableResource } from "./types.js";

export interface ResourcePillProps {
  resource: DraggableResource;
  /** Override the draggable id (defaults to resource.id) */
  draggableId?: string | undefined;
  subtitle?: string | undefined;
  pinned?: boolean | undefined;
  onOpen: () => void;
  onPin?: (() => void) | undefined;
  /** Extra data attached to the dnd-kit draggable (e.g. workspaceTabTarget) */
  extraDragData?: Record<string, unknown> | undefined;
  /** Accept drops (for secret import / SSH tunnel on desktop) */
  droppable?: boolean | undefined;
  droppableId?: string | undefined;
  isDropDisabled?: boolean | undefined;
}

export function ResourcePill({
  resource,
  draggableId,
  subtitle,
  pinned,
  onOpen,
  onPin,
  extraDragData,
  droppable,
  droppableId,
  isDropDisabled,
}: ResourcePillProps) {
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: draggableId ?? resource.id,
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
    id: droppableId ?? `drop-pill:${resource.id}`,
    disabled: !isDropTarget,
  });

  const showDropHint = isOver && isDropTarget && !isDragging;

  return (
    <div ref={setDropRef} className="inline-flex">
      <div
        ref={setDragRef}
        {...listeners}
        {...attributes}
        className={`group flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-full border transition-colors cursor-grab active:cursor-grabbing ${
          showDropHint
            ? "border-blue-500 bg-blue-500/20"
            : "border-gray-700 bg-gray-900 hover:border-gray-600"
        } ${isDragging ? "opacity-40" : ""}`}
      >
        <div onClick={onOpen} className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-gray-200 leading-none">
            {resource.displayName}
          </span>
          {subtitle && (
            <span className="text-xs text-gray-500 leading-none">{subtitle}</span>
          )}
        </div>

        {showDropHint ? (
          <span className="ml-1 text-xs text-blue-400">Drop</span>
        ) : (
          <>
            {onPin && (
              <button
                onClick={(e) => { e.stopPropagation(); onPin(); }}
                title={pinned ? "Unpin" : "Pin to dashboard"}
                className={`ml-1 p-1 rounded-full text-xs transition-all ${
                  pinned
                    ? "text-blue-400 hover:text-blue-300"
                    : "text-gray-700 hover:text-gray-400 opacity-0 group-hover:opacity-100"
                }`}
              >
                📌
              </button>
            )}

            <button
              onClick={(e) => { e.stopPropagation(); onOpen(); }}
              title="Open detail view"
              className="p-1 rounded-full text-gray-700 hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-all text-xs"
            >
              →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
