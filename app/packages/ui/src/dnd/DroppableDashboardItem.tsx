import { useDroppable, useDraggable } from "@dnd-kit/core";

export interface DroppableDashboardItemProps {
  dashboardId: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  onClick: () => void;
  onDoubleClick?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  /** When true, the item is also draggable (desktop: tab pinning) */
  draggable?: boolean | undefined;
  /** Extra data attached to the dnd-kit draggable */
  extraDragData?: Record<string, unknown> | undefined;
}

export function DroppableDashboardItem({
  dashboardId,
  name,
  isActive,
  isDefault,
  onClick,
  onDoubleClick,
  onDelete,
  draggable,
  extraDragData,
}: DroppableDashboardItemProps) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `sidebar-dashboard:${dashboardId}`,
  });

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `sidebar-dashboard-tab:${dashboardId}`,
    disabled: !draggable,
    data: {
      dragLabel: name,
      ...extraDragData,
    },
  });

  function setRefs(node: HTMLDivElement | null) {
    setDropRef(node);
    setDragRef(draggable ? node : null);
  }

  return (
    <div
      ref={setRefs}
      className={`mx-2 ${isDragging ? "opacity-40" : ""}`}
      {...(draggable ? { ...listeners, ...attributes } : {})}
    >
      <div
        className={`group flex items-center rounded-lg text-xs transition-colors ${
          isOver
            ? "bg-accent-muted border border-blue-500 text-accent-on-muted"
            : isActive
              ? "bg-surface-overlay text-on-surface"
              : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay"
        } ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
      >
        <button
          type="button"
          draggable={false}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          className="flex flex-1 items-center gap-2 px-3 py-1.5 min-w-0"
        >
          <span className="opacity-50 flex-shrink-0">⊞</span>
          <span className="truncate">{name}</span>
          {isOver && <span className="ml-auto text-accent flex-shrink-0 pr-1">Drop</span>}
        </button>
        {!isDefault && onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete dashboard"
            aria-label="Delete dashboard"
            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 mr-1.5 w-5 h-5 flex items-center justify-center rounded text-on-surface-faint hover:text-danger hover:bg-red-500/10 transition-all flex-shrink-0"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
