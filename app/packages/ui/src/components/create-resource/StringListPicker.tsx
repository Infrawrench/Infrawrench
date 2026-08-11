import { useEffect, useMemo, useState } from "react";

interface StringEntry {
  /** Stable per-row id for React keys — rows are editable and removable. */
  id: string;
  value: string;
}

interface StringListPickerProps {
  /** Current field value — a comma-separated string (e.g. "a@x.com, @y.com"). */
  value: string;
  /** Called with the updated comma-joined value. */
  onChange: (next: string) => void;
  /** Placeholder for each row's input. */
  placeholder?: string;
  /** Label on the "add" button. Defaults to "+ Add". */
  addLabel?: string;
}

/**
 * Editor for a list of single string values — emails, tags, IDs, hostnames,
 * CIDRs, and anything else that used to be typed as a comma-separated blob.
 * Each entry is its own row with a remove button; the field value is the
 * trimmed, non-empty entries joined with ", " so it drops into any plugin that
 * already splits the value on commas — no backend change needed.
 */
export function StringListPicker({
  value,
  onChange,
  placeholder,
  addLabel = "+ Add",
}: StringListPickerProps) {
  const parsed = useMemo(() => parseEntries(value), [value]);
  const [entries, setEntries] = useState<StringEntry[]>(() =>
    parsed.length > 0 ? parsed : [{ id: crypto.randomUUID(), value: "" }],
  );

  // Keep the comma-joined value in sync with local state.
  useEffect(() => {
    const joined = entries
      .map((e) => e.value.trim())
      .filter((v) => v.length > 0)
      .join(", ");
    if (joined !== value) onChange(joined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  function update(i: number, next: string) {
    setEntries((prev) => {
      const copy = [...prev];
      copy[i] = { ...(copy[i] ?? { id: crypto.randomUUID(), value: "" }), value: next };
      return copy;
    });
  }

  function addRow() {
    setEntries((prev) => [...prev, { id: crypto.randomUUID(), value: "" }]);
  }

  function removeRow(i: number) {
    setEntries((prev) =>
      prev.length > 1
        ? prev.filter((_, idx) => idx !== i)
        : [{ id: crypto.randomUUID(), value: "" }],
    );
  }

  return (
    <div className="space-y-2">
      {entries.map((entry, i) => (
        <div key={entry.id} className="flex items-center gap-2">
          <input
            type="text"
            value={entry.value}
            onChange={(e) => update(i, e.target.value)}
            onPaste={(e) => {
              // Pasting a comma-separated blob expands into one row per value
              // so users can drop in an existing list and keep editing it.
              const text = e.clipboardData.getData("text");
              if (!text.includes(",")) return;
              e.preventDefault();
              const pieces = text
                .split(",")
                .map((p) => p.trim())
                .filter((p) => p.length > 0);
              if (pieces.length === 0) return;
              setEntries((prev) => {
                const copy = [...prev];
                const head = (copy[i]?.value ?? "") + pieces[0]!;
                copy[i] = { ...(copy[i] ?? { id: crypto.randomUUID(), value: "" }), value: head };
                const rest = pieces.slice(1).map((v) => ({ id: crypto.randomUUID(), value: v }));
                copy.splice(i + 1, 0, ...rest);
                return copy;
              });
            }}
            placeholder={placeholder}
            aria-label={placeholder ?? "Value"}
            className="flex-1 min-w-0 bg-surface-overlay border border-border-strong rounded-lg px-3 py-2 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={() => removeRow(i)}
            className="flex-shrink-0 text-on-surface-faint hover:text-danger transition-colors text-sm leading-none"
            aria-label="Remove"
            title="Remove"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="text-xs text-on-surface-faint hover:text-accent transition-colors"
      >
        {addLabel}
      </button>
    </div>
  );
}

function parseEntries(value: string): StringEntry[] {
  if (!value) return [];
  return value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((v) => ({ id: crypto.randomUUID(), value: v }));
}
