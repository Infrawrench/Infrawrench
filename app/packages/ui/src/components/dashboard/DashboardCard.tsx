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
      onClick={() => selectResource(card.pluginId, card.resourceTypeId, card.resourceId)}
      className="group relative flex flex-col items-center justify-center gap-2 p-4 rounded-xl border border-gray-800 bg-gray-900 hover:border-gray-600 hover:bg-gray-850 transition-all w-40 h-40 cursor-pointer"
    >
      {/* Corner badges */}
      {card.badges && card.badges.length > 0 && (
        <div className="absolute top-2 right-2 flex gap-1">
          {card.badges.map((badge, i) => (
            <span
              key={i}
              className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700"
            >
              {badge.label}
            </span>
          ))}
        </div>
      )}

      {/* Plugin logo */}
      <div
        className="w-10 h-10 flex-shrink-0"
        dangerouslySetInnerHTML={{ __html: pluginLogoSvg }}
        aria-hidden
      />

      {/* Resource name */}
      <span className="text-sm font-medium text-gray-200 text-center leading-tight line-clamp-2">
        {card.displayName}
      </span>

      {/* Status */}
      {card.status && <StatusDotNodeRenderer node={card.status} />}
    </button>
  );
}
