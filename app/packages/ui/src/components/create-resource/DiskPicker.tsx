import { useState, useMemo } from "react";
import type { DiskOption } from "@infrawrench/plugin-base";

export function DiskPicker({
  disks,
  value,
  onChange,
}: {
  disks: DiskOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q
      ? disks.filter((d) => d.label.toLowerCase().includes(q) || d.zone?.toLowerCase().includes(q))
      : disks;
  }, [disks, search]);

  if (disks.length === 0) {
    return (
      <p className="text-sm text-on-surface-faint py-1">No existing disks found in this project.</p>
    );
  }

  return (
    <div className="border border-border-strong rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border-strong bg-surface-overlay/50">
        <input
          type="text"
          aria-label="Search disks"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search disks…"
          className="w-full bg-transparent text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none"
        />
      </div>
      <div className="max-h-52 overflow-y-auto" role="listbox" aria-label="Disks">
        {filtered.map((d) => (
          <button
            key={d.id}
            type="button"
            role="option"
            aria-selected={value === d.id}
            onClick={() => onChange(d.id)}
            className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-3 ${
              value === d.id
                ? "bg-accent-muted text-accent-on-muted"
                : "text-on-surface-secondary hover:bg-surface-overlay"
            }`}
          >
            <span
              className={`size-2 rounded-full flex-shrink-0 ${value === d.id ? "bg-blue-400" : "bg-surface-sunken"}`}
            />
            <span className="flex-1 min-w-0">
              <span className="font-medium truncate block">{d.label}</span>
              <span className="text-[11px] text-on-surface-muted">
                {d.sizeGb} GB{d.zone ? ` · ${d.zone}` : ""}
                {d.diskType ? ` · ${d.diskType}` : ""}
              </span>
            </span>
          </button>
        ))}
        {filtered.length === 0 && <p className="p-3 text-xs text-on-surface-faint">No matches</p>}
      </div>
    </div>
  );
}
