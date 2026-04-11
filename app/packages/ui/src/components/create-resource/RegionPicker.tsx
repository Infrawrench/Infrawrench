import { useState, useMemo } from "react";

export function RegionPicker({
  regions,
  value,
  onChange,
}: {
  regions: { id: string; label: string; location?: string; flag?: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q
      ? regions.filter(
          (r) =>
            r.label.toLowerCase().includes(q) ||
            r.id.toLowerCase().includes(q) ||
            r.location?.toLowerCase().includes(q),
        )
      : regions;
  }, [regions, search]);

  const selected = regions.find((r) => r.id === value);

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-700 bg-gray-800/50 flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by location or zone…"
          className="flex-1 bg-transparent text-sm text-gray-300 placeholder-gray-600 focus:outline-none"
        />
        {selected && !search && (
          <span className="text-xs text-blue-400 flex-shrink-0 flex items-center gap-1">
            {selected.flag && <span>{selected.flag}</span>}
            <span>{selected.location ?? selected.label}</span>
            <span className="font-mono text-blue-400/60">({selected.id})</span>
          </span>
        )}
      </div>
      <div className="max-h-44 overflow-y-auto">
        {filtered.map((r) => (
          <button
            key={r.id}
            onClick={() => onChange(r.id)}
            className={`w-full text-left px-3 py-2.5 transition-colors flex items-center gap-3 ${
              value === r.id ? "bg-blue-600/20" : "hover:bg-gray-800"
            }`}
          >
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${value === r.id ? "bg-blue-400" : "bg-gray-700"}`}
            />
            {r.flag && <span className="text-base leading-none flex-shrink-0">{r.flag}</span>}
            <span className="min-w-0 flex-1">
              <span
                className={`block text-sm ${value === r.id ? "text-blue-300" : "text-gray-300"}`}
              >
                {r.location ?? r.label}
              </span>
              <span
                className={`block text-[11px] font-mono mt-0.5 ${value === r.id ? "text-blue-400/70" : "text-gray-600"}`}
              >
                {r.id}
              </span>
            </span>
          </button>
        ))}
        {filtered.length === 0 && <p className="px-3 py-3 text-xs text-gray-600">No matches</p>}
      </div>
    </div>
  );
}
