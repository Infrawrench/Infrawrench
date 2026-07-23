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
    // The wrapper is non-interactive; the native button below carries the dnd
    // drag ref/listeners/attributes so the open button stays a sibling rather
    // than a focusable descendant of an interactive element.
    <div
      className={`group flex items-center gap-1 pr-1.5 rounded-full border border-border-strong bg-surface-raised hover:border-border-strong transition-colors cursor-grab active:cursor-grabbing ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <button
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        type="button"
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className="flex items-center gap-2 min-w-0 pl-3 py-1.5 text-left cursor-grab active:cursor-grabbing"
      >
        {child.status && (
          <span
            className={`size-1.5 rounded-full flex-shrink-0 ${
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
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        title="Open detail view"
        aria-label="Open detail view"
        className="p-1 rounded-full text-on-surface-faint hover:text-on-surface-secondary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-all text-xs"
      >
        →
      </button>
    </div>
  );
}
