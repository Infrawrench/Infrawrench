import { useState } from "react";
import { useGT } from "gt-react";

/** Rows shown until asked for more; the selected row always stays. */
const COLLAPSED_ROWS = 8;

export interface BarListItem {
  id: string;
  label: string;
  /** Shown after the label, quieter. */
  detail?: string | undefined;
  value: number;
  selected?: boolean;
}

interface BarListProps {
  bars: readonly BarListItem[];
  format: (value: number) => string;
  /** What the list shows, for screen readers. */
  label: string;
  /** Makes each row a button. */
  onSelect?: ((id: string) => void) | undefined;
}

/** Horizontal bars, one row each, with the value written beside it so nothing needs a hover. */
export function BarList({ bars, format, label, onSelect }: BarListProps) {
  const gt = useGT();
  const [showAll, setShowAll] = useState(false);
  const max = Math.max(...bars.map((b) => b.value), 0) || 1;
  const collapsible = bars.length > COLLAPSED_ROWS + 1;
  const shown =
    collapsible && !showAll
      ? bars.filter((b, i) => i < COLLAPSED_ROWS || b.selected === true)
      : bars;
  return (
    <div>
      <ul aria-label={label} className="flex flex-col gap-0.5 text-xs">
        {shown.map((b) => {
          const content = (
            <>
              <span
                className={`w-28 shrink-0 truncate text-left sm:w-44 ${
                  b.selected ? "font-semibold text-on-surface" : "text-on-surface-secondary"
                }`}
                title={b.detail ? `${b.label} (${b.detail})` : b.label}
              >
                {b.label}
                {b.detail && <span className="ml-1 text-on-surface-faint">{b.detail}</span>}
              </span>
              <span className="flex h-4 min-w-0 flex-1 items-center gap-2">
                <span
                  className={`h-3 shrink-0 rounded-sm ${b.selected ? "bg-accent" : "bg-accent-muted"}`}
                  style={{ width: `${Math.max((b.value / max) * 70, 0.5)}%` }}
                />
                <span className="shrink-0 tabular-nums text-on-surface-secondary">
                  {format(b.value)}
                </span>
              </span>
            </>
          );
          return (
            <li key={b.id}>
              {onSelect ? (
                <button
                  type="button"
                  aria-current={b.selected ? "true" : undefined}
                  onClick={() => onSelect(b.id)}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 hover:bg-surface-overlay"
                >
                  {content}
                </button>
              ) : (
                <div className="flex items-center gap-2 px-1 py-0.5">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      {collapsible && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
          className="mt-1 px-1 text-xs text-accent hover:text-accent-hover"
        >
          {showAll ? gt("Show fewer") : gt("Show all {count}", { count: bars.length })}
        </button>
      )}
    </div>
  );
}
