import { useState, useMemo } from "react";
import type { ImageOption } from "@infrawrench/plugin-base";
import { ImageRow } from "./ImageRow";

export function ImagePicker({ images, value, onChange }: { images: ImageOption[]; value: string; onChange: (v: string) => void }) {
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
    return images.filter((i) => i.label.toLowerCase().includes(q) || i.id.toLowerCase().includes(q));
  }, [images, search]);

  const selectedImage = images.find((i) => i.id === value);

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      {/* Search + selected summary */}
      <div className="px-3 py-2 border-b border-gray-700 bg-gray-800/50 flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search images…"
          className="flex-1 bg-transparent text-sm text-gray-300 placeholder-gray-600 focus:outline-none"
        />
        {selectedImage && !search && (
          <span className="text-xs text-blue-400 truncate max-w-[160px]">{selectedImage.label}</span>
        )}
      </div>

      <div className="max-h-52 overflow-y-auto">
        {filtered ? (
          // Flat search results
          filtered.length === 0 ? (
            <p className="px-3 py-3 text-xs text-gray-600">No matches</p>
          ) : (
            filtered.map((img) => (
              <ImageRow key={img.id} img={img} selected={value === img.id} onSelect={() => onChange(img.id)} />
            ))
          )
        ) : (
          // Categorised
          [...categories.entries()].map(([cat, catImages]) => (
            <div key={cat}>
              <div className="px-3 py-1 bg-gray-800/30 border-b border-gray-700/40">
                <span className="text-[10px] font-semibold text-gray-600 uppercase tracking-wide">{cat}</span>
              </div>
              {catImages.map((img) => (
                <ImageRow key={img.id} img={img} selected={value === img.id} onSelect={() => onChange(img.id)} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
