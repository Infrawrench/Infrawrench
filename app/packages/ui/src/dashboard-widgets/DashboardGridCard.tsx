import { useEffect, useRef, useState, type ReactNode } from "react";
import { useGT } from "gt-react";
import {
  DASHBOARD_GRID_METRICS,
  clampCardSize,
  dashboardGridColumns,
  resizeCardByKey,
  snapCardResize,
  type DashboardCardSize,
} from "@infrawrench/client-core";
import { SortableDashboardCard } from "../dnd/SortableDashboardCard.js";
import { CopyIcon, ResizeIcon } from "../components/icons/ChromeIcons.js";

/**
 * The dashboard grid's container style, shared by web and desktop so a span
 * means the same thing on both: `auto-fill` columns no narrower than
 * `minColumnPx`, and rows that are a minimum height rather than a fixed one,
 * so a card is never shorter than its content.
 */
export const DASHBOARD_GRID_STYLE: React.CSSProperties = {
  display: "grid",
  gap: `${DASHBOARD_GRID_METRICS.gapPx}px`,
  gridTemplateColumns: `repeat(auto-fill, minmax(${DASHBOARD_GRID_METRICS.minColumnPx}px, 1fr))`,
  gridAutoRows: `minmax(${DASHBOARD_GRID_METRICS.rowPx}px, auto)`,
};

/**
 * How many columns the grid lays out right now. A span wider than that is
 * drawn at the full row, and a resize snaps against it. Returns a callback
 * ref for the grid element: the grid mounts only once a dashboard has a card,
 * so a ref read once on mount would never see it.
 */
export function useDashboardGridColumns(): {
  ref: (el: HTMLElement | null) => void;
  columns: number;
} {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [columns, setColumns] = useState(4);
  useEffect(() => {
    if (!el) return;
    const measure = () => setColumns(dashboardGridColumns(el.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return { ref: setEl, columns };
}

/** The width of the grid's first column track, for snapping a drag. */
function columnTrackWidth(grid: HTMLElement | null, columns: number): number {
  if (!grid) return DASHBOARD_GRID_METRICS.minColumnPx;
  const first = Number.parseFloat(getComputedStyle(grid).gridTemplateColumns.split(" ")[0] ?? "");
  if (Number.isFinite(first) && first > 0) return first;
  const gap = DASHBOARD_GRID_METRICS.gapPx;
  return (grid.clientWidth - gap * (columns - 1)) / Math.max(1, columns);
}

export interface DashboardGridCardProps {
  /** `dashboardCardId(kind, id)`: the sortable identity. */
  id: string;
  /** The card's stored span. */
  size: DashboardCardSize;
  /** Columns the grid lays out now (`useDashboardGridColumns`). */
  columns: number;
  /** A name for the card, used in the resize and duplicate controls' labels. */
  label: string;
  /**
   * Persist a new span. Omitted for cards that have no stored size (resource
   * and workflow pins), which then show no resize handle.
   */
  onResize?: ((size: DashboardCardSize) => void) | undefined;
  /** Copy the card in place. Omitted where copying means nothing. */
  onDuplicate?: (() => void) | undefined;
  children: ReactNode;
}

/**
 * One card in the dashboard grid: sortable like before, plus a corner handle
 * that resizes it by whole column and row tracks and a duplicate button.
 *
 * The handle is a real button. Dragging it with a pointer snaps the card to
 * the nearest track as it moves and saves on release; with the keyboard the
 * arrow keys grow and shrink it one track at a time and each step saves. Both
 * stop the event before it reaches the sortable wrapper, so resizing never
 * starts a reorder drag, and a live region says the new size out loud.
 */
export function DashboardGridCard({
  id,
  size,
  columns,
  label,
  onResize,
  onDuplicate,
  children,
}: DashboardGridCardProps) {
  const gt = useGT();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<DashboardCardSize | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const drag = useRef<{
    startX: number;
    startY: number;
    start: DashboardCardSize;
    columnWidth: number;
  } | null>(null);

  const shown = clampCardSize(draft ?? size, columns);

  const describe = (s: DashboardCardSize) =>
    gt("{columns} columns wide, {rows} rows tall", { columns: s.w, rows: s.h });

  const commit = (next: DashboardCardSize) => {
    setDraft(null);
    if (next.w === size.w && next.h === size.h) return;
    setAnnouncement(describe(next));
    onResize?.(next);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!onResize || e.button !== 0) return;
    // Ours, not the sortable wrapper's: a resize is not a reorder.
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // This card's box → the sortable wrapper (the grid item) → the grid.
    const grid = wrapperRef.current?.parentElement?.parentElement ?? null;
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      start: clampCardSize(size, columns),
      columnWidth: columnTrackWidth(grid, columns),
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    setDraft(
      snapCardResize(
        d.start,
        { x: e.clientX - d.startX, y: e.clientY - d.startY },
        {
          columnWidth: d.columnWidth,
          rowHeight: DASHBOARD_GRID_METRICS.rowPx,
          gapPx: DASHBOARD_GRID_METRICS.gapPx,
          columns,
        },
      ),
    );
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    commit(draft ?? d.start);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    // Space and Enter would otherwise pick the card up for a keyboard reorder.
    if (e.key === " " || e.key === "Enter") {
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    const next = resizeCardByKey(clampCardSize(size, columns), e.key, columns);
    if (!next) return;
    e.stopPropagation();
    e.preventDefault();
    if (next.w === size.w && next.h === size.h) {
      setAnnouncement(describe(next));
      return;
    }
    commit(next);
  };

  const resizeLabel = gt("Resize {name}, now {size}. Use the arrow keys to change it.", {
    name: label,
    size: describe(shown),
  });

  return (
    <SortableDashboardCard
      id={id}
      className="group/card"
      style={{
        gridColumn: `span ${shown.w}`,
        gridRow: `span ${shown.h}`,
        ...(draft ? { outline: "2px dashed var(--color-info)", outlineOffset: 2 } : {}),
      }}
    >
      {/* One child, so the sortable wrapper's `[&>*]:h-full` stretches this box
          and the controls below stay pinned to its corner. */}
      <div ref={wrapperRef} className="relative h-full">
        <div className="h-full [&>*]:h-full">{children}</div>
        {(onDuplicate || onResize) && (
          <div className="absolute bottom-1.5 right-1.5 z-10 flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 transition-opacity">
            {onDuplicate && (
              <button
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  onDuplicate();
                }}
                title={gt("Duplicate card")}
                aria-label={gt("Duplicate {name}", { name: label })}
                className="size-6 rounded-md flex items-center justify-center text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken focus-visible:opacity-100"
              >
                <CopyIcon size={12} />
              </button>
            )}
            {onResize && (
              <button
                type="button"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => {
                  drag.current = null;
                  setDraft(null);
                }}
                onKeyDown={onKeyDown}
                title={gt("Drag to resize")}
                aria-label={resizeLabel}
                className="size-6 rounded-md flex items-center justify-center text-on-surface-faint hover:text-on-surface-secondary hover:bg-surface-sunken cursor-nwse-resize touch-none focus-visible:opacity-100"
              >
                <ResizeIcon size={12} />
              </button>
            )}
          </div>
        )}
        <span role="status" className="sr-only">
          {announcement}
        </span>
      </div>
    </SortableDashboardCard>
  );
}
