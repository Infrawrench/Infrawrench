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
  accountId,
  accountName,
  resourceGroups,
}: SidebarSectionProps) {
  const [expanded, setExpanded] = useState(true);
  const panelId = `sidebar-section-${pluginId}-${accountId}`;

  return (
    <div className="mb-2">
      {/* Plugin + account header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-on-surface-muted hover:text-on-surface-secondary transition-colors"
      >
        <span
          className="w-4 h-4 flex-shrink-0"
          dangerouslySetInnerHTML={{ __html: pluginLogoSvg }}
          aria-hidden
        />
        <span className="flex-1 text-left truncate">
          {pluginName} · {accountName}
        </span>
        <span className="text-on-surface-faint">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div id={panelId} className="space-y-1">
          {resourceGroups.map((group) => (
            <ResourceTypeGroup
              key={group.resourceTypeId}
              group={group}
              pluginId={pluginId}
              accountId={accountId}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ResourceTypeGroup({
  group,
  pluginId,
  accountId,
}: {
  group: SidebarSectionProps["resourceGroups"][number];
  pluginId: string;
  accountId: string;
}) {
  const [expanded, setExpanded] = useState(true);
  const panelId = `sidebar-group-${pluginId}-${accountId}-${group.resourceTypeId}`;

  return (
    <div>
      <button
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="w-full flex items-center gap-1 px-3 py-1 text-xs text-on-surface-faint hover:text-on-surface-tertiary transition-colors"
      >
        <span className="flex-1 text-left">{group.displayName}</span>
        <span>{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div id={panelId}>
          {group.items.map((item) => (
            <SidebarItem
              key={item.id}
              item={item}
              pluginId={pluginId}
              resourceTypeId={group.resourceTypeId}
            />
          ))}
          {group.items.length === 0 && (
            <p className="px-6 py-1 text-xs text-on-surface-faint">No resources</p>
          )}
        </div>
      )}
    </div>
  );
}
