import { useNavigate } from "@tanstack/react-router";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { DraggableResource } from "@infrawrench/ui";
import { navigateToWorkspaceTarget, resourceTabTarget } from "../../lib/workspace-tabs";

export function SidebarResourceItem({
  draggable,
  acceptsSecretImport,
  sshHostValue,
  onContextMenu,
}: {
  draggable: DraggableResource;
  acceptsSecretImport?: boolean;
  sshHostValue?: string | undefined;
  onContextMenu?: ((e: React.MouseEvent) => void) | undefined;
}) {
  const navigate = useNavigate();
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `sidebar-${draggable.id}`,
    data: {
      resource: draggable,
      workspaceTabTarget: resourceTabTarget(draggable.accountId, draggable.id),
      dragLabel: draggable.displayName,
    },
  });

  const isDropTarget = !!acceptsSecretImport || !!sshHostValue;
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `sidebar-resource:${draggable.id}`,
    disabled: !isDropTarget || isDragging,
  });

  const showDropHint = isOver && isDropTarget;

  function setRefs(node: HTMLDivElement | null) {
    setDragRef(node);
    setDropRef(node);
  }

  return (
    <div
      ref={setRefs}
      {...listeners}
      {...attributes}
      className={`flex items-center gap-2 px-3 py-1 text-xs rounded cursor-pointer transition-colors ${
        showDropHint
          ? "bg-accent-muted text-accent-on-muted ring-1 ring-inset ring-blue-500"
          : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay"
      } ${isDragging ? "opacity-40" : ""}`}
      onClick={() =>
        void navigateToWorkspaceTarget(
          navigate,
          resourceTabTarget(draggable.accountId, draggable.id),
          { label: draggable.displayName },
        )
      }
      onContextMenu={onContextMenu}
    >
      <span className="text-on-surface-faint">⠿</span>
      <span className="truncate">{draggable.displayName}</span>
      {showDropHint && <span className="ml-auto text-accent flex-shrink-0">Drop</span>}
    </div>
  );
}
