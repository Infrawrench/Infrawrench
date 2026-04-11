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

  return (
    <div ref={setDropRef} className="mx-2">
      <div
        ref={draggable ? setDragRef : undefined}
        {...(draggable ? { ...listeners, ...attributes } : {})}
        className={`group flex items-center rounded-lg text-xs transition-colors ${
          isOver
            ? "bg-blue-500/20 text-blue-200 ring-1 ring-inset ring-blue-500"
            : isActive
              ? "bg-gray-800 text-gray-100"
              : "text-gray-400 hover:text-gray-200 hover:bg-gray-800"
        } ${isDragging ? "opacity-40" : ""}`}
      >
        <button
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          className="flex flex-1 items-center gap-2 px-3 py-1.5 min-w-0"
        >
          <span className="opacity-50 flex-shrink-0">&#8862;</span>
          <span className="truncate">{name}</span>
          {isOver && <span className="ml-auto text-xs text-blue-400 flex-shrink-0">Drop</span>}
        </button>
        {!isDefault && onDelete && (
          <button
            onClick={onDelete}
            title="Delete dashboard"
            className="opacity-0 group-hover:opacity-100 mr-1.5 w-5 h-5 flex items-center justify-center rounded text-gray-600 hover:text-red-400 hover:bg-red-500/10 transition-all flex-shrink-0"
          >
            &#10005;
          </button>
        )}
      </div>
    </div>
  );
}
