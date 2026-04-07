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
      ? options.filter((opt) =>
          opt.label.toLowerCase().includes(q) || opt.id.toLowerCase().includes(q),
        )
      : options;
  }, [options, search]);

  const selected = options.find((opt) => opt.id === value);

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-700 bg-gray-800/50 flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search options…"
          className="flex-1 bg-transparent text-sm text-gray-300 placeholder-gray-600 focus:outline-none"
        />
        {selected && !search && (
          <span className="text-xs text-blue-400 truncate max-w-48">{selected.label}</span>
        )}
      </div>
      <div className="max-h-56 overflow-y-auto p-3 bg-gray-900/30">
        <div className="grid grid-cols-2 gap-2">
          {filtered.map((opt) => {
            const showSecondary = opt.label !== opt.id;
            return (
              <button
                key={opt.id}
                onClick={() => onChange(opt.id)}
                className={`text-left px-3 py-2.5 rounded-lg border transition-all min-w-0 ${
                  value === opt.id
                    ? "border-blue-500 bg-blue-600/10 text-blue-300"
                    : "border-gray-700 bg-gray-800/50 text-gray-300 hover:border-gray-600"
                }`}
              >
                <span className="block text-sm font-medium truncate">{opt.label}</span>
                {showSecondary && (
                  <span className={`block text-[11px] font-mono mt-1 truncate ${
                    value === opt.id ? "text-blue-400/70" : "text-gray-600"
                  }`}>
                    {opt.id}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {filtered.length === 0 && (
          <p className="px-1 py-2 text-xs text-gray-600">No matches</p>
        )}
      </div>
    </div>
  );
}
