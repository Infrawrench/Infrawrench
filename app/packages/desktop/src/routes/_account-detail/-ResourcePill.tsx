import type { ResourceInstance, AttachTarget } from "@infrawrench/plugin-base";
import { ResourcePill as SharedResourcePill, type DraggableResource } from "@infrawrench/ui";

/**
 * The account-detail resource pill: `@infrawrench/ui`'s ResourcePill plus the
 * desktop-only concerns — building the DraggableResource from a raw
 * ResourceInstance, deriving the SSH host for the context menu, and enabling
 * secret-import drops. The rendering, drop logic, and keyboard behavior all
 * live in the shared component.
 */
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
  onContextMenuOpen?: (
    e: { preventDefault: () => void; clientX: number; clientY: number },
    sshHost: string,
  ) => void;
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

  const contextMenu =
    (sshHost || supportsMetrics) && onContextMenuOpen
      ? (e: { preventDefault: () => void; clientX: number; clientY: number }) =>
          onContextMenuOpen(e, sshHost)
      : undefined;

  return (
    <SharedResourcePill
      resource={draggableData}
      subtitle={subtitle || undefined}
      pinned={pinned}
      onOpen={onOpen}
      onPin={onPin}
      onContextMenu={contextMenu}
      // Secret-import drops require a *different* account; attach drops (which
      // the shared pill derives from the active drag's attachTargets) require
      // the *same* account.
      droppable={!!acceptsSecretImport || !!sshHost}
      droppableId={`sidebar-resource:${resource.id}`}
    />
  );
}
