import { useState } from "react";
import type { SidebarItemSchema } from "@infrawrench/plugin-base";
import { StatusDotNodeRenderer } from "../renderer/SchemaRenderer.js";
import { useUIStore } from "../../store/ui.store.js";

interface SidebarItemProps {
  item: SidebarItemSchema;
  pluginId: string;
  resourceTypeId: string;
  depth?: number;
}

export function SidebarItem({ item, pluginId, resourceTypeId, depth = 0 }: SidebarItemProps) {
  const [expanded, setExpanded] = useState(false);
  const { selectResource, selectedResource } = useUIStore();
  const hasChildren = item.children && item.children.length > 0;
  const isSelected = selectedResource?.resourceId === item.id;

  return (
    <div>
      <button
        onClick={() => {
          selectResource(pluginId, resourceTypeId, item.id);
          if (hasChildren) setExpanded((e) => !e);
        }}
        {...(hasChildren
          ? { "aria-expanded": expanded, "aria-controls": `sidebar-children-${item.id}` }
          : {})}
        className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm rounded transition-colors text-left
          ${isSelected ? "bg-surface-overlay text-on-surface" : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-raised"}
        `}
        style={{ paddingLeft: `${12 + depth * 12}px` }}
      >
        {hasChildren && (
          <span className="text-on-surface-faint w-3 flex-shrink-0 text-xs">
            {expanded ? "▾" : "▸"}
          </span>
        )}
        {!hasChildren && <span className="w-3 flex-shrink-0" />}
        <span className="flex-1 truncate">{item.label}</span>
        {item.status && <StatusDotNodeRenderer node={item.status} />}
      </button>

      {hasChildren && expanded && (
        <div id={`sidebar-children-${item.id}`}>
          {item.children!.map((child) => (
            <SidebarItem
              key={child.id}
              item={child}
              pluginId={pluginId}
              resourceTypeId={resourceTypeId}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
