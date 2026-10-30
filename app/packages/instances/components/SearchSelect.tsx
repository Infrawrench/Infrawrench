"use client";

import { useGT } from "gt-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface SearchOption {
  value: string;
  label: string;
  /** Quieter text after the label, also searched (a region code, a currency name). */
  detail?: string;
  /** Options with the same group are listed under it, in the order groups first appear. */
  group?: string;
  disabled?: boolean;
}

interface Props {
  label: string;
  value: string;
  options: SearchOption[];
  onChange: (value: string) => void;
  /** Show the search box; by default only when there are enough options to need it. */
  searchable?: boolean;
  /** Hide the visible label (it still names the control for screen readers). */
  hideLabel?: boolean;
  className?: string;
}

/** Case- and dot-insensitive, so "m5large" finds "m5.large" and "useast1" finds "us-east-1". */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[.\-_\s()]/g, "");
}

/**
 * A select with a search box: a button that
 * opens a popover listing the options (grouped, the current one checked),
 * filtered as you type. Keyboard: arrows and Home/End move, Enter picks,
 * Escape closes; typing on the closed button opens it with that text.
 */
export function SearchSelect({
  label,
  value,
  options,
  onChange,
  searchable,
  hideLabel,
  className,
}: Props) {
  const gt = useGT();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const showSearch = searchable ?? options.length > 7;

  const selected = options.find((o) => o.value === value);
  const visible = useMemo(() => {
    const q = normalize(query);
    return q
      ? options.filter((o) => normalize(`${o.label} ${o.detail ?? ""} ${o.value}`).includes(q))
      : options;
  }, [options, query]);
  const enabled = visible.filter((o) => !o.disabled);

  function openWith(text = "") {
    setQuery(text);
    setOpen(true);
  }

  function close(refocus: boolean) {
    setOpen(false);
    setQuery("");
    if (refocus) button.current?.focus();
  }

  function pick(option: SearchOption | undefined) {
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  }

  // On opening, start on the current option and focus the search box.
  useEffect(() => {
    if (!open) return;
    const index = enabled.findIndex((o) => o.value === value);
    setActive(Math.max(0, index));
    (showSearch ? input.current : list.current)?.focus();
    // Only when it opens, not on every keystroke.
  }, [open]);

  // Typing moves the highlight back to the first match.
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  // A click anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    const last = enabled.length - 1;
    if (e.key === "ArrowDown") setActive((a) => Math.min(last, a + 1));
    else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
    else if (e.key === "Home" && !showSearch) setActive(0);
    else if (e.key === "End" && !showSearch) setActive(last);
    else if (e.key === "Enter") pick(enabled[active]);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") close(false);
    else return;
    if (e.key !== "Tab") e.preventDefault();
  }

  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-option-${i}`;
  let lastGroup: string | undefined;

  return (
    <div ref={root} className={`relative text-xs text-ink-2 ${className ?? ""}`}>
      {!hideLabel && (
        <span id={`${id}-label`} className="mb-0.5 block">
          {label}
        </span>
      )}
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        {...(hideLabel
          ? { "aria-label": label }
          : { "aria-labelledby": `${id}-label ${id}-value` })}
        onClick={() => (open ? close(false) : openWith())}
        onKeyDown={(e) => {
          if (open) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openWith();
          } else if (showSearch && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            openWith(e.key);
          }
        }}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-2 py-1 text-left text-sm text-ink hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span id={`${id}-value`} className="min-w-0 truncate">
          {selected?.label ?? value}
          {selected?.detail && <span className="ml-1 text-ink-3">{selected.detail}</span>}
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5 shrink-0 text-ink-3"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m7 15 5 5 5-5" />
          <path d="m7 9 5-5 5 5" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 z-30 mt-1 w-full min-w-64 overflow-hidden rounded-md border border-line bg-surface shadow-lg">
          {showSearch && (
            <input
              ref={input}
              type="search"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={enabled.length > 0 ? optionId(active) : undefined}
              aria-label={gt("Search {label}", { label })}
              placeholder={gt("Search {label}", { label })}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              className="w-full border-b border-line bg-transparent px-2.5 py-2 text-sm text-ink outline-none placeholder:text-ink-3"
            />
          )}
          <ul
            ref={list}
            id={listId}
            role="listbox"
            aria-label={label}
            tabIndex={showSearch ? -1 : 0}
            aria-activedescendant={!showSearch && enabled.length > 0 ? optionId(active) : undefined}
            onKeyDown={showSearch ? undefined : onKeyDown}
            className="max-h-72 overflow-y-auto py-1 outline-none"
          >
            {visible.length === 0 && (
              <li role="presentation" className="px-2.5 py-2 text-ink-3">
                {gt("No matches")}
              </li>
            )}
            {visible.map((o) => {
              const index = enabled.indexOf(o);
              const header = o.group !== undefined && o.group !== lastGroup;
              lastGroup = o.group;
              const isActive = index === active && index >= 0;
              return [
                header && (
                  <li
                    key={`group-${o.group}`}
                    role="presentation"
                    className="px-2.5 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-ink-3"
                  >
                    {o.group}
                  </li>
                ),
                <li
                  key={o.value}
                  id={index >= 0 ? optionId(index) : undefined}
                  data-index={index >= 0 ? index : undefined}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled || undefined}
                  onPointerMove={() => index >= 0 && setActive(index)}
                  onClick={() => pick(o)}
                  className={`mx-1 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm ${
                    o.disabled ? "cursor-default text-ink-3" : "text-ink"
                  } ${isActive ? "bg-surface-2" : ""}`}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    className={`h-3.5 w-3.5 shrink-0 text-accent ${o.value === value ? "" : "invisible"}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.detail && <span className="shrink-0 text-xs text-ink-3">{o.detail}</span>}
                </li>,
              ];
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
