import { useEffect, useState, useMemo } from "react";
import type { SizeOption } from "@infrawrench/plugin-base";
import { SizeCard } from "./SizeCard.js";

export function SizePicker({
  sizes,
  value,
  onChange,
  filterValue,
}: {
  sizes: SizeOption[];
  value: string;
  onChange: (v: string) => void;
  /**
   * When provided, sizes whose `availableFor` list doesn't include this value
   * are hidden. Sizes without an `availableFor` list are always shown.
   */
  filterValue?: string;
}) {
  const scoped = useMemo(() => {
    if (!filterValue) return sizes;
    const matched = sizes.filter((s) => !s.availableFor || s.availableFor.includes(filterValue));
    // Fall back to the full list when the filter excludes everything —
    // mirrors RegionPicker's defensive behaviour so a stale tagging map
    // never leaves the user with an empty picker.
    return matched.length > 0 ? matched : sizes;
  }, [sizes, filterValue]);

  // Drop the current pick if it's no longer in scope after a sibling field
  // change (e.g. engine flipped from pg to kafka); fall back to the first
  // valid size so the form never holds a value the provider would reject.
  useEffect(() => {
    if (!filterValue) return;
    if (value && !scoped.some((s) => s.id === value)) {
      const fallback = scoped[0]?.id ?? "";
      if (fallback !== value) onChange(fallback);
    }
  }, [filterValue, scoped, value, onChange]);

  const categories = useMemo(() => {
    const map = new Map<string, SizeOption[]>();
    for (const s of scoped) {
      const cat = s.category ?? "Standard";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(s);
    }
    return map;
  }, [scoped]);

  // Find which category contains the current selection, default it open
  const selectedCategory = useMemo(() => {
    for (const [cat, catSizes] of categories) {
      if (catSizes.some((s) => s.id === value)) return cat;
    }
    return [...categories.keys()][0] ?? null;
  }, [categories, value]);

  const [openCats, setOpenCats] = useState<Set<string>>(
    () => new Set(selectedCategory ? [selectedCategory] : []),
  );

  function toggleCat(cat: string) {
    setOpenCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  const maxMemory = useMemo(
    () => (scoped.length > 0 ? Math.max(...scoped.map((s) => s.memoryMb)) : 0),
    [scoped],
  );
  const maxCpu = useMemo(
    () => (scoped.length > 0 ? Math.max(...scoped.map((s) => s.vcpus)) : 0),
    [scoped],
  );

  return (
    <div className="border border-border-strong rounded-lg overflow-hidden">
      <div className="divide-y divide-border-strong/60 max-h-[260px] overflow-y-auto">
        {[...categories.entries()].map(([cat, catSizes]) => {
          const isOpen = openCats.has(cat);
          const hasSelection = catSizes.some((s) => s.id === value);
          const selectedInCat = hasSelection ? catSizes.find((s) => s.id === value) : null;
          return (
            <div key={cat}>
              <button
                type="button"
                onClick={() => toggleCat(cat)}
                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-surface-overlay/60 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="text-on-surface-faint text-[10px] transition-transform flex-shrink-0"
                    style={{
                      transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                      display: "inline-block",
                    }}
                  >
                    ▶
                  </span>
                  <span className="text-xs font-medium text-on-surface-tertiary">{cat}</span>
                </div>
                {hasSelection && !isOpen && selectedInCat && (
                  <span className="text-xs text-accent font-mono truncate ml-2">
                    {selectedInCat.label}
                  </span>
                )}
                {!hasSelection && (
                  <span className="text-xs text-on-surface-faint">{catSizes.length} options</span>
                )}
              </button>
              {isOpen && (
                <div className="px-3 pb-3 pt-1 grid grid-cols-3 gap-2 bg-surface-raised/40">
                  {catSizes.map((s) => (
                    <SizeCard
                      key={s.id}
                      size={s}
                      selected={value === s.id}
                      maxMemory={maxMemory}
                      maxCpu={maxCpu}
                      onSelect={() => onChange(s.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
