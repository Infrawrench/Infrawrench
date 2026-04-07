import { useState, useMemo } from "react";
import type { DiskOption } from "@infrawrench/plugin-base";

export function DiskPicker({ disks, value, onChange }: { disks: DiskOption[]; value: string; onChange: (v: string) => void }) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q ? disks.filter((d) => d.label.toLowerCase().includes(q) || d.zone?.toLowerCase().includes(q)) : disks;
  }, [disks, search]);

  if (disks.length === 0) {
    return <p className="text-sm text-gray-600 py-1">No existing disks found in this project.</p>;
  }

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-700 bg-gray-800/50">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search disks…"
          className="w-full bg-transparent text-sm text-gray-300 placeholder-gray-600 focus:outline-none"
        />
      </div>
      <div className="max-h-52 overflow-y-auto">
        {filtered.map((d) => (
          <button
            key={d.id}
            onClick={() => onChange(d.id)}
            className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-3 ${
              value === d.id ? "bg-blue-600/20 text-blue-300" : "text-gray-300 hover:bg-gray-800"
            }`}
          >
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${value === d.id ? "bg-blue-400" : "bg-gray-700"}`} />
            <span className="flex-1 min-w-0">
              <span className="font-medium truncate block">{d.label}</span>
              <span className="text-[11px] text-gray-500">{d.sizeGb} GB{d.zone ? ` · ${d.zone}` : ""}{d.diskType ? ` · ${d.diskType}` : ""}</span>
            </span>
          </button>
        ))}
        {filtered.length === 0 && <p className="px-3 py-3 text-xs text-gray-600">No matches</p>}
      </div>
    </div>
  );
}
