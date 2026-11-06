import { useDraggable, useDroppable, useDndContext } from "@dnd-kit/core";
import { buildResourceShowcase, type ShowcaseField } from "@infrawrench/plugin-base";
import { useGT } from "gt-react";
import { PinIcon } from "../components/icons/ChromeIcons.js";
import { useDataString } from "../i18n/data-strings.js";
import { TileFrame, TILE_ACTION_CLASS } from "./TileFrame.js";
import type { DraggableResource } from "./types.js";

export interface ResourceTileProps {
  resource: DraggableResource;
  /** Override the draggable id (defaults to resource.id) */
  draggableId?: string | undefined;
  /** The fields the type marked `showcase: true`. */
  showcase?: readonly ShowcaseField[] | undefined;
  pinned?: boolean | undefined;
  onOpen: () => void;
  onPin?: (() => void) | undefined;
  /**
   * Right-click handler for the tile (desktop's SSH / metrics context menu).
   * Also reachable by keyboard: the ContextMenu key or Shift+F10 opens it
   * anchored to the tile.
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

export function ResourceTile({
  resource,
  draggableId,
  showcase,
  pinned,
  onOpen,
  onPin,
  onContextMenu,
  extraDragData,
  droppable,
  droppableId,
  isDropDisabled,
}: ResourceTileProps) {
  const gt = useGT();
  const gtData = useDataString();
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
  const dropHintLabel = attachDropOk
    ? attachMatch?.verb
      ? gtData(attachMatch.verb)
      : gt("Attach")
    : gt("Drop");

  return (
    <div ref={setDropRef} className="inline-flex">
      <TileFrame
        iconKey={resource.iconKey}
        name={resource.displayName}
        showcase={buildResourceShowcase(resource.fields, showcase)}
        isDragging={isDragging}
        dropHint={
          showDropHint ? (
            <span className="rounded bg-accent px-1.5 py-0.5 text-xs font-medium text-on-accent">
              {dropHintLabel}
            </span>
          ) : undefined
        }
        actions={
          onPin ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onPin();
              }}
              title={pinned ? gt("Unpin") : gt("Pin to dashboard")}
              aria-label={pinned ? gt("Unpin") : gt("Pin to dashboard")}
              aria-pressed={!!pinned}
              className={`${TILE_ACTION_CLASS} ${
                pinned
                  ? "text-on-surface"
                  : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              }`}
            >
              <PinIcon size={14} />
            </button>
          ) : undefined
        }
        buttonRef={setDragRef}
        buttonProps={{
          ...attributes,
          ...listeners,
          onClick: onOpen,
          onKeyDown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen();
              return;
            }
            // Keyboard equivalent of right-click: open the context menu at the tile.
            if (onContextMenu && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              onContextMenu({ preventDefault: () => {}, clientX: rect.left, clientY: rect.bottom });
            }
          },
          ...(onContextMenu ? { onContextMenu } : {}),
        }}
      />
    </div>
  );
}
