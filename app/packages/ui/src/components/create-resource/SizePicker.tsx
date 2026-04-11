import { useState, useMemo } from "react";
import type { SizeOption } from "@infrawrench/plugin-base";
import { SizeCard } from "./SizeCard.js";

export function SizePicker({
  sizes,
  value,
  onChange,
}: {
  sizes: SizeOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  const categories = useMemo(() => {
    const map = new Map<string, SizeOption[]>();
    for (const s of sizes) {
      const cat = s.category ?? "Standard";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(s);
    }
    return map;
  }, [sizes]);

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

  const maxMemory = useMemo(() => Math.max(...sizes.map((s) => s.memoryMb)), [sizes]);
  const maxCpu = useMemo(() => Math.max(...sizes.map((s) => s.vcpus)), [sizes]);

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <div className="divide-y divide-gray-700/60 max-h-[260px] overflow-y-auto">
        {[...categories.entries()].map(([cat, catSizes]) => {
          const isOpen = openCats.has(cat);
          const hasSelection = catSizes.some((s) => s.id === value);
          const selectedInCat = hasSelection ? catSizes.find((s) => s.id === value) : null;
          return (
            <div key={cat}>
              <button
                onClick={() => toggleCat(cat)}
                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-800/60 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className="text-gray-600 text-[10px] transition-transform flex-shrink-0"
                    style={{
                      transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
                      display: "inline-block",
                    }}
                  >
                    ▶
                  </span>
                  <span className="text-xs font-medium text-gray-400">{cat}</span>
                </div>
                {hasSelection && !isOpen && selectedInCat && (
                  <span className="text-xs text-blue-400 font-mono truncate ml-2">
                    {selectedInCat.label}
                  </span>
                )}
                {!hasSelection && (
                  <span className="text-xs text-gray-600">{catSizes.length} options</span>
                )}
              </button>
              {isOpen && (
                <div className="px-3 pb-3 pt-1 grid grid-cols-3 gap-2 bg-gray-900/40">
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
