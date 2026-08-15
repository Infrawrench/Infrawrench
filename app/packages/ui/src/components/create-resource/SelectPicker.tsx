import { useState, useMemo } from "react";
import { useGT } from "gt-react";
import type { SelectOption } from "@infrawrench/plugin-base";
import { useDataString } from "../../i18n/data-strings.js";
import { selectPickerColumns, selectOptionSecondaryLines } from "./select-layout.js";

export function SelectPicker({
  options,
  value,
  onChange,
}: {
  options: SelectOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q
      ? options.filter(
          (opt) =>
            opt.label.toLowerCase().includes(q) ||
            opt.id.toLowerCase().includes(q) ||
            (opt.description ?? "").toLowerCase().includes(q),
        )
      : options;
  }, [options, search]);
  // Decided from the full option list, not the filtered one, so the grid
  // doesn't reflow to two columns mid-search.
  const columns = selectPickerColumns(options);

  const selected = options.find((opt) => opt.id === value);

  return (
    <div className="border border-border-strong rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border-strong bg-surface-overlay/50 flex items-center gap-2">
        <input
          type="text"
          aria-label={gt("Search options")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={gt("Search options…")}
          className="flex-1 bg-transparent text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none"
        />
        {selected && !search && (
          <span className="text-xs text-accent truncate max-w-48">{gtData(selected.label)}</span>
        )}
      </div>
      <div
        className="max-h-56 overflow-y-auto p-3 bg-surface-raised/30"
        role="listbox"
        aria-label={gt("Options")}
      >
        <div className={`grid gap-2 ${columns === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
          {filtered.map((opt) => {
            const secondary = selectOptionSecondaryLines(opt);
            return (
              <button
                key={opt.id}
                type="button"
                role="option"
                aria-selected={value === opt.id}
                onClick={() => onChange(opt.id)}
                className={`text-left px-3 py-2.5 rounded-lg border transition-all min-w-0 ${
                  value === opt.id
                    ? "border-blue-500 bg-accent-muted text-accent-on-muted"
                    : "border-border-strong bg-surface-overlay/50 text-on-surface-secondary hover:border-border-strong"
                }`}
              >
                {/* Wraps rather than truncates: a label too long even for the
                    full-width column stays readable instead of losing its tail. */}
                <span className="block text-sm font-medium break-words leading-snug">
                  {gtData(opt.label)}
                </span>
                {secondary.description && (
                  <span
                    className={`block text-[11px] mt-1 break-words leading-snug ${
                      value === opt.id ? "text-accent/70" : "text-on-surface-faint"
                    }`}
                  >
                    {gtData(secondary.description)}
                  </span>
                )}
                {secondary.id && (
                  <span
                    className={`block text-[11px] font-mono mt-1 truncate ${
                      value === opt.id ? "text-accent/70" : "text-on-surface-faint"
                    }`}
                  >
                    {secondary.id}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {filtered.length === 0 && (
          <p className="px-1 py-2 text-xs text-on-surface-faint">{gt("No matches")}</p>
        )}
      </div>
    </div>
  );
}
