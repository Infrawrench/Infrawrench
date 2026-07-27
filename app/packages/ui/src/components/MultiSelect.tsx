import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface MultiSelectOption {
  value: string;
  label: string;
}

/**
 * Replaces the option list when there is nothing to show yet. Kept separate
 * from `options` so a failed load can offer a retry rather than looking like
 * "no results".
 */
export type MultiSelectStatus =
  | { kind: "loading" }
  | { kind: "error"; message: string; onRetry?: () => void }
  | { kind: "empty"; message: string };

export interface MultiSelectProps {
  options: MultiSelectOption[];
  value: string[];
  onChange: (values: string[]) => void;
  /** Accessible name for the control. */
  label: string;
  /** Shown in the closed control when nothing is selected. */
  placeholder?: string;
  status?: MultiSelectStatus | undefined;
  /** Called when the panel opens — a good moment to retry a failed load. */
  onOpen?: (() => void) | undefined;
  className?: string;
}

/** Beyond this many chips the control summarizes rather than growing. */
const MAX_VISIBLE_CHIPS = 4;

const controlClass =
  "w-full min-w-0 rounded-lg border border-border bg-surface-sunken px-2 py-1.5 text-left text-sm " +
  "text-on-surface focus:outline-none focus:border-blue-500";

/**
 * A filterable multi-select.
 *
 * The panel expands inline rather than floating: every consumer so far sits
 * inside a modal whose body is `overflow-y-auto`, which clips absolutely
 * positioned children the moment the list is taller than the space below it.
 * Growing in flow costs a layout shift and buys correct behaviour everywhere
 * without a portal.
 */
export function MultiSelect({
  options,
  value,
  onChange,
  label,
  placeholder = "Any",
  status,
  onOpen,
  className = "",
}: MultiSelectProps) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const labelByValue = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of options) m.set(o.value, o.label);
    return m;
  }, [options]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const selected = useMemo(() => new Set(value), [value]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // Keep the highlighted row in range as the query narrows the list, and in
  // view as the arrows walk past the fold.
  useEffect(() => {
    setActiveIndex((i) => (i >= filtered.length ? 0 : i));
  }, [filtered.length]);

  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector(`[data-index="${activeIndex}"]`);
    // Guarded rather than called blind: jsdom has no scrollIntoView, and this
    // is a nicety — it must never take the component down with it.
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  const openPanel = () => {
    setOpen(true);
    onOpen?.();
  };

  const close = () => {
    setOpen(false);
    setQuery("");
    buttonRef.current?.focus();
  };

  const toggle = (v: string) => {
    onChange(selected.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) =>
        filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[activeIndex];
      if (opt) toggle(opt.value);
      return;
    }
    // Backspace on an empty query peels off the last selection, the way chip
    // inputs generally behave.
    if (e.key === "Backspace" && query === "" && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  const visible = value.slice(0, MAX_VISIBLE_CHIPS);
  const overflow = value.length - visible.length;
  const listboxId = `${uid}-listbox`;

  return (
    <div ref={rootRef} className={`relative min-w-0 ${className}`}>
      {/*
        The chips sit beside the disclosure button rather than inside it: a
        <button> may not contain interactive descendants, so a nested remove
        control would be invalid markup and unreachable for screen-reader
        users. The button takes the remaining width so most of the control is
        still a click target for opening the panel.
      */}
      <div className={`${controlClass} flex flex-wrap items-center gap-1`}>
        {visible.map((v) => (
          <span
            key={v}
            className="inline-flex max-w-full items-center gap-1 rounded border border-border bg-surface-raised px-1.5 py-0.5 text-xs"
          >
            <span className="truncate">{labelByValue.get(v) ?? v}</span>
            <button
              type="button"
              aria-label={`Remove ${labelByValue.get(v) ?? v}`}
              className="text-on-surface-faint hover:text-on-surface"
              onClick={() => onChange(value.filter((x) => x !== v))}
            >
              ✕
            </button>
          </span>
        ))}
        {overflow > 0 && (
          <span className="text-xs text-on-surface-secondary">+{overflow} more</span>
        )}
        <button
          ref={buttonRef}
          type="button"
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="listbox"
          className="flex min-w-[3rem] flex-1 items-center text-left"
          onClick={() => (open ? close() : openPanel())}
        >
          {value.length === 0 && <span className="text-on-surface-faint">{placeholder}</span>}
          <span className="ml-auto pl-1 text-on-surface-faint">▾</span>
        </button>
      </div>

      {open && (
        <div className="mt-1 rounded-lg border border-border bg-surface-raised p-1.5">
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            {...(filtered[activeIndex]
              ? { "aria-activedescendant": `${uid}-opt-${activeIndex}` }
              : {})}
            aria-label={`Filter ${label}`}
            placeholder="Type to filter…"
            className="w-full rounded border border-border bg-surface-sunken px-2 py-1 text-sm text-on-surface focus:outline-none focus:border-blue-500"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />

          <div className="mt-1 flex items-center justify-between px-1 text-[11px] text-on-surface-faint">
            <span>
              {value.length > 0 ? `${value.length} selected` : `${options.length} available`}
            </span>
            {value.length > 0 && (
              <button
                type="button"
                className="text-blue-400 hover:text-blue-300"
                onClick={() => onChange([])}
              >
                Clear
              </button>
            )}
          </div>

          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-multiselectable="true"
            aria-label={label}
            className="mt-1 max-h-48 overflow-y-auto"
          >
            {filtered.map((o, i) => {
              const isSelected = selected.has(o.value);
              return (
                <li
                  key={o.value}
                  id={`${uid}-opt-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={isSelected}
                  className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm ${
                    i === activeIndex ? "bg-surface-sunken" : ""
                  } ${isSelected ? "text-on-surface" : "text-on-surface-secondary"}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => toggle(o.value)}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-sm border text-[10px] ${
                      isSelected ? "border-blue-500 bg-blue-600 text-white" : "border-border"
                    }`}
                  >
                    {isSelected ? "✓" : ""}
                  </span>
                  <span className="truncate">{o.label}</span>
                </li>
              );
            })}

            {filtered.length === 0 && options.length > 0 && (
              <li className="px-2 py-1 text-sm text-on-surface-faint">No matches for “{query}”</li>
            )}

            {options.length === 0 && status?.kind === "loading" && (
              <li className="px-2 py-1 text-sm text-on-surface-faint">Loading values…</li>
            )}
            {options.length === 0 && status?.kind === "empty" && (
              <li className="px-2 py-1 text-sm text-on-surface-faint">{status.message}</li>
            )}
            {options.length === 0 && status?.kind === "error" && (
              <li className="px-2 py-1 text-sm text-on-surface-faint">
                {status.message}{" "}
                {status.onRetry && (
                  <button
                    type="button"
                    className="text-blue-400 hover:text-blue-300"
                    onClick={status.onRetry}
                  >
                    Retry
                  </button>
                )}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
