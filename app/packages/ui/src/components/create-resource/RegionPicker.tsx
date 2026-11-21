import { useEffect, useState, useMemo } from "react";
import { useGT } from "gt-react";

/**
 * What a row of the picker says. A `label` that is only the id in another case
 * ("NYC1" for `nyc1`, or `us-east-2` itself) is a code, so the `location`
 * ("New York") is the readable name. Any other label is the option's own name
 * ("East US", "EU", or a plan such as "Developer ($20/month)" from a plugin
 * that reuses the picker for something that is not a region), and `location`
 * becomes the detail under it. The id follows unless it is the main line.
 */
export function regionOptionLines(r: { id: string; label: string; location?: string }): {
  primary: string;
  detail: string | null;
  id: string | null;
} {
  const labelIsCode = r.label.toLowerCase() === r.id.toLowerCase();
  const primary = labelIsCode ? (r.location ?? r.label) : r.label;
  return {
    primary,
    detail: r.location && r.location !== primary ? r.location : null,
    id: r.id !== primary ? r.id : null,
  };
}

export function RegionPicker({
  regions,
  value,
  onChange,
  filterValue,
  fieldLabel,
}: {
  regions: readonly {
    id: string;
    label: string;
    location?: string;
    flag?: string;
    availableFor?: string[];
  }[];
  value: string;
  onChange: (v: string) => void;
  /**
   * When provided, regions whose `availableFor` list doesn't include this value
   * are hidden. Regions without an `availableFor` list are always shown.
   */
  filterValue?: string;
  /**
   * The field's label, already translated. Plugins reuse the picker for lists
   * that are not regions (a plan, a tier), so the search box and the list are
   * named after the field when it is given.
   */
  fieldLabel?: string | undefined;
}) {
  const gt = useGT();
  const [search, setSearch] = useState("");
  const scoped = useMemo(() => {
    if (!filterValue) return regions;
    const matched = regions.filter((r) => !r.availableFor || r.availableFor.includes(filterValue));
    // Fall back to the full list when the filter excludes everything:
    // protects against incomplete or stale per-value tagging (e.g. provider
    // API that renamed an engine and no longer reports any region under the
    // form's engine label). Better to let the user pick and surface the
    // provider's error than to lock them out of the form.
    return matched.length > 0 ? matched : regions;
  }, [regions, filterValue]);
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q
      ? scoped.filter(
          (r) =>
            r.label.toLowerCase().includes(q) ||
            r.id.toLowerCase().includes(q) ||
            r.location?.toLowerCase().includes(q),
        )
      : scoped;
  }, [scoped, search]);

  const selected = scoped.find((r) => r.id === value);
  const selectedLines = selected ? regionOptionLines(selected) : null;

  // If the current value is no longer in the scoped list (e.g. user changed
  // the engine to one that doesn't support the previously-picked region),
  // reset to the first scoped option so the form never holds an invalid
  // value the provider will reject.
  useEffect(() => {
    if (!filterValue) return;
    if (value && !scoped.some((r) => r.id === value)) {
      const fallback = scoped[0]?.id ?? "";
      if (fallback !== value) onChange(fallback);
    }
  }, [filterValue, scoped, value, onChange]);

  return (
    <div className="border border-border-strong rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border-strong bg-surface-overlay/50 flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={
            fieldLabel
              ? gt("Search {field}…", { field: fieldLabel })
              : gt("Search by location or zone…")
          }
          className="flex-1 bg-transparent text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none"
          aria-label={
            fieldLabel ? gt("Search {field}", { field: fieldLabel }) : gt("Search regions")
          }
        />
        {selectedLines && !search && (
          <span
            className="text-xs text-accent min-w-0 max-w-[60%] flex items-center gap-1"
            title={selectedLines.primary}
          >
            {selected?.flag && <span className="flex-shrink-0">{selected.flag}</span>}
            <span className="truncate">{selectedLines.primary}</span>
            {selectedLines.id && (
              <span className="font-mono text-accent/60 flex-shrink-0">({selectedLines.id})</span>
            )}
          </span>
        )}
      </div>
      <div
        className="max-h-44 overflow-y-auto"
        role="listbox"
        aria-label={fieldLabel ?? gt("Regions")}
      >
        {filtered.map((r) => {
          const lines = regionOptionLines(r);
          return (
            <button
              key={r.id}
              type="button"
              role="option"
              aria-selected={value === r.id}
              onClick={() => onChange(r.id)}
              className={`w-full text-left px-3 py-2.5 transition-colors flex items-center gap-3 ${
                value === r.id ? "bg-accent-muted" : "hover:bg-surface-overlay"
              }`}
            >
              <span
                className={`size-2 rounded-full flex-shrink-0 ${value === r.id ? "bg-accent" : "bg-surface-sunken"}`}
              />
              {r.flag && <span className="text-base leading-none flex-shrink-0">{r.flag}</span>}
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-sm ${value === r.id ? "text-accent-on-muted" : "text-on-surface-secondary"}`}
                >
                  {lines.primary}
                </span>
                {(lines.detail || lines.id) && (
                  <span
                    className={`block text-[11px] mt-0.5 ${value === r.id ? "text-accent/70" : "text-on-surface-faint"}`}
                  >
                    {lines.detail && <span>{lines.detail}</span>}
                    {lines.detail && lines.id && <span aria-hidden="true"> · </span>}
                    {lines.id && <span className="font-mono">{lines.id}</span>}
                  </span>
                )}
              </span>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p className="p-3 text-xs text-on-surface-faint">{gt("No matches")}</p>
        )}
      </div>
    </div>
  );
}
