import { useState, useMemo } from "react";
import { useGT } from "gt-react";
import type { ImageOption } from "@infrawrench/plugin-base";
import { useDataString } from "../../i18n/data-strings.js";
import { ImageRow } from "./ImageRow.js";

export function ImagePicker({
  images,
  value,
  onChange,
}: {
  images: ImageOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const [search, setSearch] = useState("");

  const categories = useMemo(() => {
    const map = new Map<string, ImageOption[]>();
    for (const img of images) {
      const cat = img.category ?? "Other";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(img);
    }
    return map;
  }, [images]);

  const filtered = useMemo(() => {
    if (!search) return null; // no search — show categorised
    const q = search.toLowerCase();
    return images.filter(
      (i) => i.label.toLowerCase().includes(q) || i.id.toLowerCase().includes(q),
    );
  }, [images, search]);

  const selectedImage = images.find((i) => i.id === value);

  return (
    <div className="border border-border-strong rounded-lg overflow-hidden">
      {/* Search + selected summary */}
      <div className="px-3 py-2 border-b border-border-strong bg-surface-overlay/50 flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={gt("Search images…")}
          aria-label={gt("Search images")}
          className="flex-1 bg-transparent text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none"
        />
        {selectedImage && !search && (
          <span className="text-xs text-accent truncate max-w-[160px]">
            {gtData(selectedImage.label)}
          </span>
        )}
      </div>

      <div className="max-h-52 overflow-y-auto" role="listbox" aria-label={gt("Images")}>
        {filtered ? (
          // Flat search results
          filtered.length === 0 ? (
            <p className="p-3 text-xs text-on-surface-faint">{gt("No matches")}</p>
          ) : (
            filtered.map((img) => (
              <ImageRow
                key={img.id}
                img={img}
                selected={value === img.id}
                onSelect={() => onChange(img.id)}
              />
            ))
          )
        ) : (
          // Categorised
          [...categories.entries()].map(([cat, catImages]) => (
            <div key={cat}>
              <div className="px-3 py-1 bg-surface-overlay/30 border-b border-border-strong/40">
                <span className="text-[10px] font-semibold text-on-surface-faint uppercase tracking-wide">
                  {gtData(cat)}
                </span>
              </div>
              {catImages.map((img) => (
                <ImageRow
                  key={img.id}
                  img={img}
                  selected={value === img.id}
                  onSelect={() => onChange(img.id)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
