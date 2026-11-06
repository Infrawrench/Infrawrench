import type { DashboardCardSchema } from "@infrawrench/plugin-base";
import { PinIcon } from "../icons/ChromeIcons.js";
import { DashboardCard } from "./DashboardCard.js";

interface DashboardGridProps {
  cards: Array<{ card: DashboardCardSchema; pluginLogoSvg: string }>;
  emptyMessage?: string;
}

export function DashboardGrid({
  cards,
  emptyMessage = "Pin resources to see them here.",
}: DashboardGridProps) {
  if (cards.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-on-surface-faint">
        <PinIcon size={32} className="mb-3" />
        <p className="text-sm">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-4">
      {cards.map(({ card, pluginLogoSvg }) => (
        <DashboardCard
          key={`${card.pluginId}:${card.resourceId}`}
          card={card}
          pluginLogoSvg={pluginLogoSvg}
        />
      ))}
    </div>
  );
}
