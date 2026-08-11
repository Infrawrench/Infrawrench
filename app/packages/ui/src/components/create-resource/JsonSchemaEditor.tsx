import { useEffect, useMemo, useState } from "react";

/**
 * Structured, no-code JSON Schema builder. Each row is one top-level
 * property (name · type · required · description); the field value is a
 * JSON-Schema object string (`{"type":"object","properties":{…},"required":[…]}`),
 * or an empty string when no named properties exist (so optional fields stay
 * unset). Drops into any string-valued `CreateFieldConfig` via `kind:
 * "json-schema"` — no Monaco, no raw-text editing.
 *
 * Scope: top-level object properties with primitive / array / object types.
 * Deep nesting isn't modelled here — for an array/object the type is declared
 * but its items/sub-properties aren't (valid JSON Schema, just unconstrained).
 */

const PROPERTY_TYPES = ["string", "integer", "number", "boolean", "array", "object"] as const;
type PropertyType = (typeof PROPERTY_TYPES)[number];

interface PropertyRow {
  /** Stable per-row id for React keys — rows are editable and removable. */
  id: string;
  name: string;
  type: PropertyType;
  required: boolean;
  description: string;
}

interface JsonSchemaEditorProps {
  value: string;
  onChange: (next: string) => void;
}

export function JsonSchemaEditor({ value, onChange }: JsonSchemaEditorProps) {
  const parsed = useMemo(() => parseSchema(value), [value]);
  const [rows, setRows] = useState<PropertyRow[]>(() => parsed);

  // Keep the serialized JSON Schema in sync with the row state.
  useEffect(() => {
    const next = serializeSchema(rows);
    if (next !== value) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  function update(i: number, patch: Partial<PropertyRow>) {
    setRows((prev) => {
      const next = [...prev];
      next[i] = { ...(next[i] ?? blankRow()), ...patch };
      return next;
    });
  }

  function addRow() {
    setRows((prev) => [...prev, blankRow()]);
  }

  function removeRow(i: number) {
    setRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  return (
    <div className="space-y-2 rounded-lg border border-border-strong bg-surface-overlay/40 p-3">
      {rows.length === 0 && (
        <p className="text-xs text-on-surface-faint">
          No properties yet. Add one to describe the function's fields.
        </p>
      )}
      {rows.length > 0 && (
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-on-surface-faint">
          <span className="flex-1">Property</span>
          <span className="w-24">Type</span>
          <span className="w-16 text-center">Required</span>
          <span className="w-5" />
        </div>
      )}
      {rows.map((row, i) => (
        <div key={row.id} className="space-y-1.5">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={row.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder="property name"
              aria-label="Property name"
              spellCheck={false}
              className="flex-1 min-w-0 bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
            />
            <select
              value={row.type}
              onChange={(e) => update(i, { type: e.target.value as PropertyType })}
              aria-label="Property type"
              className="w-24 bg-surface-overlay border border-border-strong rounded-lg px-2 py-1.5 text-sm text-on-surface-secondary focus:outline-none focus:border-blue-500"
            >
              {PROPERTY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <label className="w-16 flex justify-center" title="Required">
              <input
                type="checkbox"
                checked={row.required}
                onChange={(e) => update(i, { required: e.target.checked })}
                aria-label="Required"
                className="accent-blue-500"
              />
            </label>
            <button
              type="button"
              onClick={() => removeRow(i)}
              className="w-5 flex-shrink-0 text-on-surface-faint hover:text-danger transition-colors text-sm leading-none"
              aria-label="Remove property"
              title="Remove property"
            >
              ✕
            </button>
          </div>
          <input
            type="text"
            value={row.description}
            onChange={(e) => update(i, { description: e.target.value })}
            placeholder="description (optional)"
            aria-label="Property description"
            spellCheck={false}
            className="w-full bg-surface-overlay/60 border border-border rounded-lg px-3 py-1 text-xs text-on-surface-tertiary placeholder:text-on-surface-faint focus:outline-none focus:border-blue-500"
          />
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="text-xs text-on-surface-faint hover:text-accent transition-colors"
      >
        + Add property
      </button>
    </div>
  );
}

function blankRow(): PropertyRow {
  return { id: crypto.randomUUID(), name: "", type: "string", required: false, description: "" };
}

/** Serialize property rows to a JSON-Schema object string; "" when empty. */
function serializeSchema(rows: PropertyRow[]): string {
  const named = rows.filter((r) => r.name.trim());
  if (named.length === 0) return "";
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];
  for (const r of named) {
    const prop: { type: string; description?: string } = { type: r.type };
    if (r.description.trim()) prop.description = r.description.trim();
    properties[r.name.trim()] = prop;
    if (r.required) required.push(r.name.trim());
  }
  const schema: {
    type: "object";
    properties: typeof properties;
    required?: string[];
  } = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return JSON.stringify(schema, null, 2);
}

/** Parse an existing JSON-Schema object string back into editable rows. */
function parseSchema(json: string): PropertyRow[] {
  if (!json.trim()) return [];
  try {
    const obj = JSON.parse(json) as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    const props = obj.properties ?? {};
    const required = new Set(Array.isArray(obj.required) ? obj.required : []);
    return Object.entries(props).map(([name, def]) => {
      const t = String(def?.type ?? "string");
      const type = (PROPERTY_TYPES as readonly string[]).includes(t)
        ? (t as PropertyType)
        : "string";
      return {
        id: crypto.randomUUID(),
        name,
        type,
        required: required.has(name),
        description: String(def?.description ?? ""),
      };
    });
  } catch {
    return [];
  }
}
