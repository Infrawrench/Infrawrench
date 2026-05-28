import { useState, useMemo } from "react";
import { encodeOutputRef, parseOutputRef } from "@infrawrench/plugin-base";

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
  /**
   * When true, selecting a resource emits an encoded *live output reference*
   * (identity + value) instead of the flattened literal. The host persists it
   * as an association so the consuming field tracks the source over time.
   */
  referenceMode = false,
}: {
  resources: ResourcePickerOption[];
  value: string;
  onChange: (v: string) => void;
  referenceMode?: boolean;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q ? resources.filter((r) => r.label.toLowerCase().includes(q)) : resources;
  }, [resources, search]);

  const handleSelect = (r: ResourcePickerOption) => {
    if (referenceMode) {
      onChange(
        encodeOutputRef({
          pluginId: r.pluginId,
          resourceTypeId: r.resourceTypeId,
          resourceId: r.id,
          accountId: r.accountId,
          outputKey: r.outputKey,
          value: r.outputValue,
        }),
      );
    } else {
      onChange(r.outputValue);
    }
  };

  // In reference mode the form value is an encoded ref — match the selected row
  // by its resource id. Otherwise match by the literal output value.
  const refValue = referenceMode ? parseOutputRef(value) : null;
  const selectedResource = referenceMode
    ? resources.find((r) => r.id === refValue?.resourceId)
    : resources.find((r) => r.outputValue === value);

  if (resources.length === 0) {
    return <p className="text-sm text-on-surface-faint py-1">No compatible resources found.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="border border-border-strong rounded-lg overflow-hidden">
        <div className="px-3 py-2 border-b border-border-strong bg-surface-overlay/50">
          <input
            type="text"
            aria-label="Search resources"
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
              onClick={() => handleSelect(r)}
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
