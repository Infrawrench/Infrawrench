import { useNavigate } from "@tanstack/react-router";
import { useDraggable, useDroppable, useDndContext } from "@dnd-kit/core";
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

  // When a Cloudflare Tunnel (or other SSH-tunnel source) is being dragged and
  // this row is an SSH host, become a cross-account "set up SSH tunnel" target.
  const { active } = useDndContext();
  const activeResource = active?.data.current?.resource as DraggableResource | undefined;
  const tunnelAttachOk =
    !!activeResource?.isTunnelSshSource &&
    !!draggable.isSshHost &&
    activeResource.id !== draggable.id;

  const isDropTarget = !!acceptsSecretImport || !!sshHostValue || tunnelAttachOk;
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: tunnelAttachOk ? `tunnel-ssh-attach:${draggable.id}` : `sidebar-resource:${draggable.id}`,
    disabled: !isDropTarget || isDragging,
    ...(tunnelAttachOk ? { data: { target: draggable } } : {}),
  });

  const showDropHint = isOver && isDropTarget;

  function setRefs(node: HTMLDivElement | null) {
    setDragRef(node);
    setDropRef(node);
  }

  const activate = () =>
    void navigateToWorkspaceTarget(navigate, resourceTabTarget(draggable.accountId, draggable.id), {
      label: draggable.displayName,
    });

  return (
    <div
      ref={setRefs}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      className={`flex items-center gap-2 px-3 py-1 text-xs rounded cursor-pointer transition-colors ${
        showDropHint
          ? "bg-accent-muted text-accent-on-muted ring-1 ring-inset ring-blue-500"
          : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay"
      } ${isDragging ? "opacity-40" : ""}`}
      onClick={activate}
      onKeyDown={(e) => {
        if (isDragging) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      }}
      onContextMenu={onContextMenu}
    >
      <span className="text-on-surface-faint">⠿</span>
      <span className="truncate">{draggable.displayName}</span>
      {showDropHint && (
        <span className="ml-auto text-accent flex-shrink-0">
          {tunnelAttachOk ? "Set up SSH tunnel" : "Drop"}
        </span>
      )}
    </div>
  );
}
