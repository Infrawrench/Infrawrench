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
      onClick={onOpen}
      className={`group flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-full border border-border-strong bg-surface-raised hover:border-border-strong transition-colors cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
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
                      : "bg-surface-sunken"
            }`}
          />
        )}
        <span className="text-sm font-medium text-on-surface-secondary leading-none">
          {child.displayName}
        </span>
        {child.subtitle && (
          <span className="text-xs text-on-surface-muted leading-none">{child.subtitle}</span>
        )}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        title="Open detail view"
        className="p-1 rounded-full text-on-surface-faint hover:text-on-surface-secondary opacity-0 group-hover:opacity-100 transition-all text-xs"
      >
        →
      </button>
    </div>
  );
}
