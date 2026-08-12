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
  /**
   * Right-click handler for the pill's main button (desktop's SSH / metrics
   * context menu). Also reachable by keyboard — the ContextMenu key or
   * Shift+F10 opens it anchored to the pill.
   */
  onContextMenu?:
    ((e: { preventDefault: () => void; clientX: number; clientY: number }) => void) | undefined;
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
  onContextMenu,
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
      {/* The wrapper is non-interactive; the native button below carries the dnd
          drag ref/listeners/attributes so the pin/open buttons stay siblings
          rather than focusable descendants of an interactive element. */}
      <div
        className={`group flex items-center gap-1 pr-1.5 rounded-full border transition-colors cursor-grab active:cursor-grabbing ${
          showDropHint
            ? "border-blue-500 bg-accent-muted"
            : "border-border-strong bg-surface-raised hover:border-border-strong"
        } ${isDragging ? "opacity-40" : ""}`}
      >
        <button
          ref={setDragRef}
          {...listeners}
          {...attributes}
          type="button"
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen();
              return;
            }
            // Keyboard equivalent of right-click: open the context menu at the pill.
            if (onContextMenu && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              onContextMenu({ preventDefault: () => {}, clientX: rect.left, clientY: rect.bottom });
            }
          }}
          onContextMenu={onContextMenu}
          className="flex items-center gap-2 min-w-0 pl-3 py-1.5 text-left cursor-grab active:cursor-grabbing"
        >
          <span className="text-sm font-medium text-on-surface-secondary leading-none">
            {resource.displayName}
          </span>
          {subtitle && (
            <span className="text-xs text-on-surface-muted leading-none">{subtitle}</span>
          )}
        </button>

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
                aria-label={pinned ? "Unpin" : "Pin to dashboard"}
                className={`ml-1 p-1 rounded-full text-xs transition-all ${
                  pinned
                    ? "text-accent hover:text-accent-on-muted"
                    : "text-on-surface-faint hover:text-on-surface-tertiary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
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
              aria-label="Open detail view"
              className="p-1 rounded-full text-on-surface-faint hover:text-on-surface-secondary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-all text-xs"
            >
              →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
