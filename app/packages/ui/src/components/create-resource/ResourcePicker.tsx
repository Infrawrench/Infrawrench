import { useState, useMemo } from "react";

export interface ResourcePickerOption {
  id: string;
  label: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  outputKey: string;
  outputValue: string;
}

export function ResourcePicker({
  resources,
  value,
  onChange,
}: {
  resources: ResourcePickerOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q ? resources.filter((r) => r.label.toLowerCase().includes(q)) : resources;
  }, [resources, search]);

  const selectedResource = resources.find((r) => r.outputValue === value);

  if (resources.length === 0) {
    return <p className="text-sm text-on-surface-faint py-1">No compatible resources found.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="border border-border-strong rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-border-strong bg-surface-overlay/50">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search resources..."
            className="w-full bg-transparent text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none"
          />
        </div>
        <div className="max-h-52 overflow-y-auto" role="listbox" aria-label="Resources">
          {filtered.map((r) => (
            <button
              key={r.id}
              type="button"
              role="option"
              aria-selected={selectedResource?.id === r.id}
              onClick={() => onChange(r.outputValue)}
              className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-3 ${
                selectedResource?.id === r.id
                  ? "bg-accent-muted text-accent-on-muted"
                  : "text-on-surface-secondary hover:bg-surface-overlay"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${
                  selectedResource?.id === r.id ? "bg-blue-400" : "bg-surface-sunken"
                }`}
              />
              <span className="flex-1 min-w-0">
                <span className="font-medium truncate block">{r.label}</span>
                <span className="text-[11px] text-on-surface-muted">{r.outputKey}</span>
              </span>
            </button>
          ))}
          {filtered.length === 0 && <p className="p-3 text-xs text-on-surface-faint">No matches</p>}
        </div>
      </div>
      {selectedResource && (
        <p className="text-xs text-on-surface-faint">
          Selected: <code className="text-accent">{selectedResource.outputValue}</code>
        </p>
      )}
    </div>
  );
}
