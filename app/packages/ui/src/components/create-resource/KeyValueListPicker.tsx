import { useEffect, useMemo, useState } from "react";

interface KeyValueEntry {
  key: string;
  value: string;
}

interface KeyValueListPickerProps {
  /** Current field value — a JSON-serialized array of { [keyName]: string, [valueName]: string } objects. */
  value: string;
  /** Called with the updated JSON-serialized value. */
  onChange: (next: string) => void;
  /** Output JSON key for the row's text input. Defaults to "key". */
  keyName?: string;
  /** Output JSON key for the row's picked option. Defaults to "value". */
  valueName?: string;
  keyLabel?: string;
  keyPlaceholder?: string;
  valueLabel?: string;
  options: Array<{ id: string; label: string }>;
  valueDefault?: string;
  addLabel?: string;
  minEntries?: number;
  maxEntries?: number;
}

/**
 * Generic editor for a list of (text, pick-one) rows — e.g. Firestore index
 * fields (fieldPath + order), firewall rule allow-lists (port + protocol),
 * tag lists, and so on. Stores its value as a JSON-serialized array so it
 * drops into any string-valued `CreateFieldConfig` without special plumbing.
 */
export function KeyValueListPicker({
  value,
  onChange,
  keyName = "key",
  valueName = "value",
  keyLabel,
  keyPlaceholder,
  valueLabel,
  options,
  valueDefault,
  addLabel = "+ Add",
  minEntries = 0,
  maxEntries,
}: KeyValueListPickerProps) {
  const parsed = useMemo(
    () => parseEntries(value, keyName, valueName),
    [value, keyName, valueName],
  );
  const [entries, setEntries] = useState<KeyValueEntry[]>(() => {
    if (parsed.length > 0) return parsed;
    const init: KeyValueEntry[] = [];
    const defaultVal = valueDefault ?? options[0]?.id ?? "";
    for (let i = 0; i < Math.max(minEntries, 1); i++) {
      init.push({ key: "", value: defaultVal });
    }
    return init;
  });

  // Keep the serialized value in sync with local state.
  useEffect(() => {
    const json = JSON.stringify(entries.map((e) => ({ [keyName]: e.key, [valueName]: e.value })));
    if (json !== value) onChange(json);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  function update(i: number, patch: Partial<KeyValueEntry>) {
    setEntries((prev) => {
      const next = [...prev];
      next[i] = { ...(next[i] ?? { key: "", value: valueDefault ?? "" }), ...patch };
      return next;
    });
  }

  function addRow() {
    if (maxEntries !== undefined && entries.length >= maxEntries) return;
    setEntries((prev) => [...prev, { key: "", value: valueDefault ?? options[0]?.id ?? "" }]);
  }

  function removeRow(i: number) {
    setEntries((prev) => (prev.length > minEntries ? prev.filter((_, idx) => idx !== i) : prev));
  }

  return (
    <div className="space-y-2">
      {entries.map((entry, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            {keyLabel && i === 0 && (
              <div className="text-[10px] uppercase tracking-wide text-on-surface-faint mb-1">
                {keyLabel}
              </div>
            )}
            <input
              type="text"
              value={entry.key}
              onChange={(e) => update(i, { key: e.target.value })}
              placeholder={keyPlaceholder}
              aria-label={keyLabel ?? keyPlaceholder ?? keyName}
              className="w-full bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex-shrink-0">
            {valueLabel && i === 0 && (
              <div className="text-[10px] uppercase tracking-wide text-on-surface-faint mb-1">
                {valueLabel}
              </div>
            )}
            <div className="flex gap-1">
              {options.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => update(i, { value: opt.id })}
                  className={`px-3 py-2 rounded-lg border text-xs transition-all ${
                    entry.value === opt.id
                      ? "border-blue-500 bg-accent-muted text-accent-on-muted"
                      : "border-border-strong bg-surface-overlay/50 text-on-surface-tertiary hover:border-border-strong"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            onClick={() => removeRow(i)}
            disabled={entries.length <= minEntries}
            className={`flex-shrink-0 text-on-surface-faint hover:text-red-400 transition-colors text-sm leading-none disabled:opacity-30 disabled:hover:text-on-surface-faint ${
              valueLabel && i === 0 ? "mt-5" : "mt-2.5"
            }`}
            aria-label="Remove row"
            title="Remove row"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        disabled={maxEntries !== undefined && entries.length >= maxEntries}
        className="text-xs text-on-surface-faint hover:text-accent transition-colors disabled:opacity-30"
      >
        {addLabel}
      </button>
    </div>
  );
}

function parseEntries(json: string, keyName: string, valueName: string): KeyValueEntry[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as Array<Record<string, unknown>>;
    if (!Array.isArray(arr)) return [];
    return arr.map((o) => ({
      key: String(o?.[keyName] ?? ""),
      value: String(o?.[valueName] ?? ""),
    }));
  } catch {
    return [];
  }
}
