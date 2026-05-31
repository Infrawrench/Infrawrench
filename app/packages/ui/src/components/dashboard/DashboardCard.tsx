import type { DashboardCardSchema } from "@infrawrench/plugin-base";
import { StatusDotNodeRenderer } from "../renderer/SchemaRenderer.js";
import { useUIStore } from "../../store/ui.store.js";

interface DashboardCardProps {
  card: DashboardCardSchema;
  pluginLogoSvg: string;
}

/**
 * Dashboard card — the canonical infrawrench card format:
 *   ┌──────────────┐
 *   │   [logo svg] │
 *   │  <name>      │
 *   │  ● status    │
 *   └──────────────┘
 */
export function DashboardCard({ card, pluginLogoSvg }: DashboardCardProps) {
  const { selectResource } = useUIStore();

  return (
    <button
      type="button"
      onClick={() => selectResource(card.pluginId, card.resourceTypeId, card.resourceId)}
      className="group relative flex flex-col items-center justify-center gap-2 p-4 rounded-xl border border-border bg-surface-raised hover:border-border-strong hover:bg-surface-raised transition-all size-40 cursor-pointer"
    >
      {/* Corner badges */}
      {card.badges && card.badges.length > 0 && (
        <div className="absolute top-2 right-2 flex gap-1">
          {card.badges.map((badge, i) => (
            <span
              key={`${badge.label}-${i}`}
              className="text-xs px-1.5 py-0.5 rounded bg-surface-overlay text-on-surface-tertiary border border-border-strong"
            >
              {badge.label}
            </span>
          ))}
        </div>
      )}

      {/* Plugin logo */}
      <div
        className="size-10 flex-shrink-0"
        // pluginLogoSvg is a static provider logo from the plugin's bundled
        // manifest (plugin.manifest.logoSvg) — never user-controllable input.
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: pluginLogoSvg }}
        aria-hidden
      />

      {/* Resource name */}
      <span className="text-sm font-medium text-on-surface-secondary text-center leading-tight line-clamp-2">
        {card.displayName}
      </span>

      {/* Status */}
      {card.status && <StatusDotNodeRenderer node={card.status} />}
    </button>
  );
}
