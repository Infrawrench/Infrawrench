import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { DraggableResource } from "@infrawrench/ui";
import { accountTabTarget } from "../../lib/workspace-tabs";
import type { Account, PluginGroup } from "./types";

export function AccountDraggableRow({
  account,
  group,
  isExpanded,
  connected,
  acceptsSecretImport,
  onToggleExpand,
  onNavigate,
  onDelete,
}: {
  account: Account;
  group: PluginGroup;
  isExpanded: boolean;
  connected: boolean;
  acceptsSecretImport: boolean;
  onToggleExpand: () => void;
  onNavigate: () => void;
  onDelete?: (() => void) | undefined;
}) {
  const draggableData: DraggableResource = {
    id: account.id,
    pluginId: account.pluginId,
    resourceTypeId: "__account__",
    accountId: account.id,
    displayName: account.displayName,
    fields: { pluginId: account.pluginId, pluginDisplayName: group.displayName },
  };

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `account-${account.id}`,
    data: {
      resource: draggableData,
      workspaceTabTarget: accountTabTarget(account.id),
      dragLabel: account.displayName,
    },
  });

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `sidebar-account:${account.id}`,
    disabled: !acceptsSecretImport || isDragging,
  });

  const showDropHint = isOver && acceptsSecretImport;

  function setRefs(node: HTMLDivElement | null) {
    setDragRef(node);
    setDropRef(node);
  }

  return (
    <div
      ref={setRefs}
      {...listeners}
      {...attributes}
      className={`flex items-center w-full px-4 py-1.5 text-sm transition-colors group cursor-grab active:cursor-grabbing ${
        showDropHint
          ? "bg-accent-muted text-accent-on-muted ring-1 ring-inset ring-blue-500"
          : "text-on-surface-secondary hover:bg-surface-overlay hover:text-on-surface"
      } ${isDragging ? "opacity-40" : ""}`}
    >
      <button
        type="button"
        draggable={false}
        onClick={(e) => {
          e.stopPropagation();
          onToggleExpand();
        }}
        title={isExpanded ? "Collapse" : "Expand resources"}
        className="size-4 flex items-center justify-center flex-shrink-0 text-on-surface-faint hover:text-on-surface-tertiary transition-colors mr-1"
      >
        <span
          className="inline-block transition-transform text-xs"
          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
      </button>
      <button
        type="button"
        draggable={false}
        onClick={(e) => {
          e.stopPropagation();
          onNavigate();
        }}
        className="flex items-center gap-2 flex-1 text-left min-w-0"
      >
        <span
          className={`size-1.5 rounded-full flex-shrink-0 transition-colors ${connected ? "bg-blue-400" : "bg-surface-sunken"}`}
        />
        <span className="truncate">{account.displayName}</span>
      </button>
      {showDropHint && <span className="text-xs text-accent flex-shrink-0">Drop</span>}
      {!showDropHint && onDelete && (
        <button
          type="button"
          draggable={false}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete account"
          aria-label="Delete account"
          className="flex-shrink-0 size-5 flex items-center justify-center rounded text-on-surface-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:text-danger hover:bg-red-500/10 transition-all"
        >
          ✕
        </button>
      )}
    </div>
  );
}
