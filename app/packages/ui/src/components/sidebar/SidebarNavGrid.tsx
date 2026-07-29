/**
 * The tiles above the dashboard list — Agents, Workflows, Deploy, Costs.
 *
 * One 2×2 grid rather than four stacked rows: the icons are a mix of text
 * glyphs and SVGs with different natural widths, so stacked rows never quite
 * lined up. A fixed-width icon slot per tile is what actually aligns the labels.
 *
 * Shared by web and desktop, which is why the odd-count rule exists at all:
 * desktop hides the Costs tile in local mode (spend is collected server-side),
 * and three tiles in a two-column grid would otherwise leave a ragged hole.
 */
export interface SidebarNavTileDef {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}

export function SidebarNavGrid({ tiles }: { tiles: SidebarNavTileDef[] }) {
  if (tiles.length === 0) return null;
  const odd = tiles.length % 2 === 1;
  return (
    <div className="mx-2 mb-2 grid grid-cols-2 gap-1">
      {tiles.map((tile, i) => (
        <SidebarNavTile
          key={tile.key}
          label={tile.label}
          icon={tile.icon}
          onClick={tile.onClick}
          // Last tile of an odd set spans the row, so the grid ends square.
          className={odd && i === tiles.length - 1 ? "col-span-2" : ""}
        />
      ))}
    </div>
  );
}

export function SidebarNavTile({
  label,
  icon,
  onClick,
  className = "",
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors ${className}`}
    >
      <span className="flex w-3.5 flex-none items-center justify-center opacity-60">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
