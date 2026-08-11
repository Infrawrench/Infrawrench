import { useState } from "react";
import {
  FloatingPortal,
  autoUpdate,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from "@floating-ui/react";

/**
 * The nav tiles above the dashboard list — Agents, Workflows, Deploy, and
 * friends. Icon-only: the labeled two-column grid stopped scaling once the
 * tile count hit double digits, so each tile is just its icon and the label
 * lives in a floating tooltip (Floating UI) shown on hover/focus.
 *
 * Shared by web and desktop, and the tile list is not a fixed length —
 * desktop hides the cloud-only tiles in local mode — so the column count is
 * computed: at most 7 tiles per row, split evenly so a wrap never leaves a
 * near-empty second row (14 → 7+7, 10 → 5+5, 8 → 4+4, 7 → one row).
 *
 * When the count does not divide evenly the last row is short (16 → 6+6+4),
 * and a short row flush against the left edge reads as broken. It is centred
 * by laying the grid out in half-tile columns and giving the first tile of the
 * last row an explicit column start: the leftover is `cols - lastRowCount`
 * whole tiles, so half of it is that many half-columns — an exact offset even
 * when the leftover is odd (13 → 7+6, centred by half a tile). Doubling the
 * columns leaves tile widths and gaps unchanged, since each tile then spans
 * two half-columns plus the gap between them.
 */
export interface SidebarNavTileDef {
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}

const MAX_TILES_PER_ROW = 7;

export function SidebarNavGrid({ tiles }: { tiles: SidebarNavTileDef[] }) {
  if (tiles.length === 0) return null;
  const rows = Math.ceil(tiles.length / MAX_TILES_PER_ROW);
  const cols = Math.ceil(tiles.length / rows);
  const firstOfLastRow = (rows - 1) * cols;
  const halfColumnOffset = cols - (tiles.length - firstOfLastRow);
  return (
    <div
      className="mx-2 mb-2 grid gap-1"
      style={{ gridTemplateColumns: `repeat(${cols * 2}, minmax(0, 1fr))` }}
    >
      {tiles.map((tile, index) => (
        <SidebarNavTile
          key={tile.key}
          label={tile.label}
          icon={tile.icon}
          onClick={tile.onClick}
          className="col-span-2"
          style={
            index === firstOfLastRow && halfColumnOffset > 0
              ? { gridColumnStart: halfColumnOffset + 1 }
              : undefined
          }
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
  style,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  className?: string;
  style?: React.CSSProperties | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "bottom",
    middleware: [offset(6), shift({ padding: 4 })],
    whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { move: false, delay: { open: 300, close: 0 } });
  const focus = useFocus(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "tooltip" });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        onClick={onClick}
        aria-label={label}
        style={style}
        {...getReferenceProps()}
        className={`flex items-center justify-center rounded-lg py-1.5 text-xs text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay transition-colors ${className}`}
      >
        <span className="flex items-center justify-center opacity-60">{icon}</span>
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-50 rounded-md border border-border bg-surface-raised px-2 py-1 text-xs text-on-surface-secondary shadow-md pointer-events-none"
          >
            {label}
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
