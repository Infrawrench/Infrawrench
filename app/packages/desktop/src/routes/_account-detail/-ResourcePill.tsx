import { useDraggable, useDroppable, useDndContext } from "@dnd-kit/core";
import type { ResourceInstance, AttachTarget } from "@infrawrench/plugin-base";
import type { DraggableResource } from "@infrawrench/ui";

export function ResourcePill({
  resource,
  typeId,
  attachTargets,
  pinned,
  acceptsSecretImport,
  sshHostOutputKey,
  sshRunningWhen,
  supportsMetrics,
  onPin,
  onOpen,
  onContextMenuOpen,
}: {
  resource: ResourceInstance;
  typeId: string;
  attachTargets?: AttachTarget[] | undefined;
  pinned: boolean;
  acceptsSecretImport?: boolean;
  sshHostOutputKey?: string;
  sshRunningWhen?: { fieldKey: string; value: string };
  supportsMetrics?: boolean;
  onPin: () => void;
  onOpen: () => void;
  onContextMenuOpen?: (e: React.MouseEvent, sshHost: string) => void;
}) {
  const subtitle = String(
    resource.fields["host"] ?? resource.fields["region"] ?? resource.fields["engine"] ?? "",
  );

  const draggableData: DraggableResource = {
    id: resource.id,
    pluginId: resource.pluginId,
    resourceTypeId: typeId,
    accountId: resource.accountId,
    displayName: resource.displayName,
    fields: resource.fields,
    externalId: resource.externalId,
    ...(attachTargets && attachTargets.length > 0 ? { attachTargets } : {}),
  };

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: resource.id,
    data: { resource: draggableData },
  });

  let sshHost = "";
  if (sshHostOutputKey) {
    let isRunning = true;
    if (sshRunningWhen) {
      const fieldVal = String(resource.fields[sshRunningWhen.fieldKey] ?? "");
      isRunning = fieldVal.toLowerCase() === sshRunningWhen.value.toLowerCase();
    }
    if (isRunning) {
      sshHost = String(
        resource.resolvedOutputs?.[sshHostOutputKey] ?? resource.fields[sshHostOutputKey] ?? "",
      );
    }
  }

  // Separate droppable from draggable — combining refs on the same node in a
  // flex-wrap layout causes @dnd-kit to lose rect measurements during drag.
  const { active } = useDndContext();
  const activeResource = active?.data.current?.resource as DraggableResource | undefined;
  const sameCluster = activeResource?.accountId === resource.accountId;
  // Secret-import drops require a *different* account; attach drops require the *same* account.
  const secretDropOk = (!!acceptsSecretImport || !!sshHost) && !sameCluster;
  const attachMatch = activeResource?.attachTargets?.find(
    (t) => t.pluginId === resource.pluginId && t.resourceTypeId === typeId,
  );
  const attachDropOk =
    sameCluster &&
    !!attachMatch &&
    activeResource?.id !== resource.id &&
    (!attachMatch.matchField ||
      String(activeResource?.fields?.[attachMatch.matchField] ?? "") ===
        String(resource.fields[attachMatch.matchField] ?? ""));
  const isDropTarget = secretDropOk || attachDropOk;
  const droppableId = attachDropOk
    ? `attach-target:${resource.id}`
    : `sidebar-resource:${resource.id}`;
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: droppableId,
    disabled: !isDropTarget,
    ...(attachDropOk ? { data: { target: draggableData } } : {}),
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
        onContextMenu={
          (sshHost || supportsMetrics) && onContextMenuOpen
            ? (e) => onContextMenuOpen(e, sshHost)
            : undefined
        }
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
                  : "text-on-surface-faint hover:text-on-surface-tertiary opacity-0 group-hover:opacity-100"
              }`}
            >
              📌
            </button>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
              title="Open detail view"
              aria-label="Open detail view"
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
