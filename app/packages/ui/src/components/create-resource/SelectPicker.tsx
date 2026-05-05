import { useState, useMemo } from "react";

export function SelectPicker({
  options,
  value,
  onChange,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q
      ? options.filter(
          (opt) => opt.label.toLowerCase().includes(q) || opt.id.toLowerCase().includes(q),
        )
      : options;
  }, [options, search]);

  const selected = options.find((opt) => opt.id === value);

  return (
    <div className="border border-border-strong rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border-strong bg-surface-overlay/50 flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search options…"
          className="flex-1 bg-transparent text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none"
        />
        {selected && !search && (
          <span className="text-xs text-accent truncate max-w-48">{selected.label}</span>
        )}
      </div>
      <div className="max-h-56 overflow-y-auto p-3 bg-surface-raised/30">
        <div className="grid grid-cols-2 gap-2">
          {filtered.map((opt) => {
            const showSecondary = opt.label !== opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChange(opt.id)}
                className={`text-left px-3 py-2.5 rounded-lg border transition-all min-w-0 ${
                  value === opt.id
                    ? "border-blue-500 bg-accent-muted text-accent-on-muted"
                    : "border-border-strong bg-surface-overlay/50 text-on-surface-secondary hover:border-border-strong"
                }`}
              >
                <span className="block text-sm font-medium truncate">{opt.label}</span>
                {showSecondary && (
                  <span
                    className={`block text-[11px] font-mono mt-1 truncate ${
                      value === opt.id ? "text-accent/70" : "text-on-surface-faint"
                    }`}
                  >
                    {opt.id}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {filtered.length === 0 && (
          <p className="px-1 py-2 text-xs text-on-surface-faint">No matches</p>
        )}
      </div>
    </div>
  );
}
