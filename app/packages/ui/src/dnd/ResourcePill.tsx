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
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
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
  const isDropTarget = secretDropOk || attachDropOk;
  const effectiveDroppableId = attachDropOk
    ? `attach-target:${resource.id}`
    : (droppableId ?? `drop-pill:${resource.id}`);

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: effectiveDroppableId,
    disabled: !isDropTarget,
    ...(attachDropOk ? { data: { target: resource } } : {}),
  });

  const showDropHint = isOver && isDropTarget && !isDragging;
  const dropHintLabel = attachDropOk ? (attachMatch?.verb ?? "Attach") : "Drop";

  return (
    <div ref={setDropRef} className="inline-flex">
      <div
        ref={setDragRef}
        {...listeners}
        {...attributes}
        onClick={onOpen}
        className={`group flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-full border transition-colors cursor-grab active:cursor-grabbing ${
          showDropHint
            ? "border-blue-500 bg-accent-muted"
            : "border-border-strong bg-surface-raised hover:border-border-strong"
        } ${isDragging ? "opacity-40" : ""}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-on-surface-secondary leading-none">
            {resource.displayName}
          </span>
          {subtitle && (
            <span className="text-xs text-on-surface-muted leading-none">{subtitle}</span>
          )}
        </div>

        {showDropHint ? (
          <span className="ml-1 text-xs text-accent">{dropHintLabel}</span>
        ) : (
          <>
            {onPin && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPin();
                }}
                title={pinned ? "Unpin" : "Pin to dashboard"}
                className={`ml-1 p-1 rounded-full text-xs transition-all ${
                  pinned
                    ? "text-accent hover:text-accent-on-muted"
                    : "text-on-surface-faint hover:text-on-surface-tertiary opacity-0 group-hover:opacity-100"
                }`}
              >
                📌
              </button>
            )}

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
              title="Open detail view"
              className="p-1 rounded-full text-on-surface-faint hover:text-on-surface-secondary opacity-0 group-hover:opacity-100 transition-all text-xs"
            >
              →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
