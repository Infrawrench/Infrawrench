import { useDraggable } from "@dnd-kit/core";
import { buildResourceShowcase, type ShowcaseField } from "@infrawrench/plugin-base";
import type { ChildResource } from "../components/detail/DetailView.js";
import { StatusIssueIndicator } from "../components/IssueIndicator.js";
import { TileFrame } from "./TileFrame.js";
import type { DraggableResource } from "./types.js";

export interface DraggableChildTileProps {
  child: ChildResource;
  /** The child type's icon, from `ChildResourceGroup.iconKey`. */
  iconKey?: string | undefined;
  /** The fields the child type marked `showcase: true`, from `ChildResourceGroup.showcase`. */
  showcase?: readonly ShowcaseField[] | undefined;
  onOpen: () => void;
  /** Extra data attached to the dnd-kit draggable (e.g. workspaceTabTarget) */
  extraDragData?: Record<string, unknown> | undefined;
}

export function DraggableChildTile({
  child,
  iconKey,
  showcase,
  onOpen,
  extraDragData,
}: DraggableChildTileProps) {
  const draggableData: DraggableResource = {
    id: child.id,
    pluginId: child.pluginId,
    resourceTypeId: child.resourceTypeId,
    accountId: child.accountId,
    displayName: child.displayName,
    fields: {},
    ...(iconKey ? { iconKey } : {}),
  };

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `child-${child.id}`,
    data: {
      resource: draggableData,
      dragLabel: child.displayName,
      ...extraDragData,
    },
  });

  return (
    <TileFrame
      iconKey={iconKey}
      name={child.displayName}
      subtitle={child.subtitle}
      {...(child.fields ? { showcase: buildResourceShowcase(child.fields, showcase) } : {})}
      isDragging={isDragging}
      status={
        child.status ? (
          <StatusIssueIndicator status={child.status.status} label={child.status.label} />
        ) : undefined
      }
      buttonRef={setNodeRef}
      buttonProps={{
        ...attributes,
        ...listeners,
        onClick: onOpen,
        onKeyDown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        },
      }}
    />
  );
}
