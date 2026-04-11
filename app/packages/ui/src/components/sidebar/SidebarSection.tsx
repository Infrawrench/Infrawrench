import { useState } from "react";
import type { SidebarItemSchema } from "@infrawrench/plugin-base";
import { SidebarItem } from "./SidebarItem.js";

interface SidebarSectionProps {
  /** Plugin display name (e.g. "DigitalOcean") */
  pluginName: string;
  /** Plugin logo SVG */
  pluginLogoSvg: string;
  pluginId: string;
  /** Account display name (e.g. "my-do-account") */
  accountName: string;
  accountId: string;
  /** Resource types with their sidebar item trees */
  resourceGroups: Array<{
    resourceTypeId: string;
    displayName: string;
    items: SidebarItemSchema[];
  }>;
}

export function SidebarSection({
  pluginName,
  pluginLogoSvg,
  pluginId,
  accountName,
  resourceGroups,
}: SidebarSectionProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="mb-2">
      {/* Plugin + account header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-300 transition-colors"
      >
        <span
          className="w-4 h-4 flex-shrink-0"
          dangerouslySetInnerHTML={{ __html: pluginLogoSvg }}
          aria-hidden
        />
        <span className="flex-1 text-left truncate">
          {pluginName} · {accountName}
        </span>
        <span className="text-gray-700">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div className="space-y-1">
          {resourceGroups.map((group) => (
            <ResourceTypeGroup key={group.resourceTypeId} group={group} pluginId={pluginId} />
          ))}
        </div>
      )}
    </div>
  );
}

function ResourceTypeGroup({
  group,
  pluginId,
}: {
  group: SidebarSectionProps["resourceGroups"][number];
  pluginId: string;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-1 px-3 py-1 text-xs text-gray-600 hover:text-gray-400 transition-colors"
      >
        <span className="flex-1 text-left">{group.displayName}</span>
        <span>{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div>
          {group.items.map((item) => (
            <SidebarItem
              key={item.id}
              item={item}
              pluginId={pluginId}
              resourceTypeId={group.resourceTypeId}
            />
          ))}
          {group.items.length === 0 && (
            <p className="px-6 py-1 text-xs text-gray-700">No resources</p>
          )}
        </div>
      )}
    </div>
  );
}
