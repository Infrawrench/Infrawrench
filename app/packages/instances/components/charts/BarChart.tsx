"use client";

export interface Bar {
  id: string;
  label: string;
  /** Shown after the label, quieter. */
  detail?: string;
  value: number;
  selected?: boolean;
}

/**
 * Horizontal bars, one row each, with the value written at the end of the bar
 * so nothing needs a hover to read. A row can be a link or a button.
 */
export function BarChart({
  bars,
  format,
  label,
  onSelect,
}: {
  bars: Bar[];
  format: (value: number) => string;
  label: string;
  onSelect?: (id: string) => void;
}) {
  const max = Math.max(...bars.map((b) => b.value), 0) || 1;
  return (
    <ul aria-label={label} className="flex flex-col gap-0.5 text-xs">
      {bars.map((b) => {
        const content = (
          <>
            <span
              className={`w-44 shrink-0 truncate text-left ${b.selected ? "font-semibold text-ink" : "text-ink-2"}`}
            >
              {b.label}
              {b.detail && <span className="ml-1 text-ink-3">{b.detail}</span>}
            </span>
            <span className="relative flex h-4 flex-1 items-center">
              <span
                className="h-3 rounded-r-[4px] transition-[width]"
                style={{
                  // Leaves room for the value label at full length.
                  width: `calc((100% - 5.5rem) * ${Math.max(0.005, b.value / max)})`,
                  background: b.selected ? "var(--bar-selected)" : "var(--bar)",
                }}
              />
              <span
                className={`ml-1.5 shrink-0 tabular-nums ${b.selected ? "font-semibold text-ink" : "text-ink-2"}`}
              >
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
                title={`${b.label}: ${format(b.value)}`}
                aria-pressed={b.selected ?? false}
                onClick={() => onSelect(b.id)}
                className="flex w-full items-center gap-2 rounded px-1 py-px hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
              >
                {content}
              </button>
            ) : (
              <div
                title={`${b.label}: ${format(b.value)}`}
                className="flex items-center gap-2 rounded px-1 py-px hover:bg-surface-2"
              >
                {content}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
