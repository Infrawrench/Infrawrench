import { useDraggable } from "@dnd-kit/core";
import type { ChildResource } from "../components/detail/DetailView.js";
import type { DraggableResource } from "./types.js";

export interface DraggableChildPillProps {
  child: ChildResource;
  onOpen: () => void;
  /** Extra data attached to the dnd-kit draggable (e.g. workspaceTabTarget) */
  extraDragData?: Record<string, unknown> | undefined;
}

export function DraggableChildPill({ child, onOpen, extraDragData }: DraggableChildPillProps) {
  const draggableData: DraggableResource = {
    id: child.id,
    pluginId: child.pluginId,
    resourceTypeId: child.resourceTypeId,
    accountId: child.accountId,
    displayName: child.displayName,
    fields: {},
  };

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `child-${child.id}`,
    data: {
      resource: draggableData,
      dragLabel: child.displayName,
      ...extraDragData,
    },
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`group flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-full border border-gray-700 bg-gray-900 hover:border-gray-600 transition-colors cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <div onClick={onOpen} className="flex items-center gap-2 min-w-0">
        {child.status && (
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              child.status.status === "healthy"
                ? "bg-blue-400"
                : child.status.status === "error"
                  ? "bg-red-400"
                  : child.status.status === "degraded"
                    ? "bg-yellow-400"
                    : child.status.status === "provisioning"
                      ? "bg-blue-400 animate-pulse"
                      : "bg-gray-500"
            }`}
          />
        )}
        <span className="text-sm font-medium text-gray-200 leading-none">{child.displayName}</span>
        {child.subtitle && (
          <span className="text-xs text-gray-500 leading-none">{child.subtitle}</span>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        title="Open detail view"
        className="p-1 rounded-full text-gray-700 hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-all text-xs"
      >
        →
      </button>
    </div>
  );
}
