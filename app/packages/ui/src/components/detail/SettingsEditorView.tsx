import { useCallback, useEffect, useMemo, useState } from "react";
import type { SettingsEditorCapability, SettingDescriptor } from "@infrawrench/plugin-base";
import { ErrorNotice } from "../ErrorNotice.js";

export interface SettingsEditorViewProps {
  capability: SettingsEditorCapability;
  /** Returns a JSON string of `{ settings: SettingDescriptor[] }`. */
  onGetManifest: () => Promise<string>;
  /** Receives a JSON array of changed `{ id, value }` pairs. */
  onApplyManifest?: (manifest: string) => Promise<void>;
}

/**
 * Human-friendly settings form rendered in place of a raw JSON editor. The
 * plugin describes each setting (label / control / options / value) via
 * `getManifest`; this view renders toggles, dropdowns, and inputs, tracks
 * edits, and applies only the changed `{ id, value }` pairs.
 */
export function SettingsEditorView({
  capability,
  onGetManifest,
  onApplyManifest,
}: SettingsEditorViewProps) {
  const [settings, setSettings] = useState<SettingDescriptor[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [initial, setInitial] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const raw = await onGetManifest();
      const parsed = JSON.parse(raw) as { settings?: SettingDescriptor[] };
      const list = parsed.settings ?? [];
      setSettings(list);
      const seed: Record<string, string> = {};
      for (const s of list) seed[s.id] = s.value;
      setValues(seed);
      setInitial(seed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load settings");
      setSettings(null);
    } finally {
      setLoading(false);
    }
  }, [onGetManifest]);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = useMemo(() => {
    if (!settings) return [];
    return settings
      .filter((s) => s.control !== "readonly" && values[s.id] !== initial[s.id])
      .map((s) => ({ id: s.id, value: values[s.id] ?? "" }));
  }, [settings, values, initial]);

  const grouped = useMemo(() => {
    const groups = new Map<string, SettingDescriptor[]>();
    for (const s of settings ?? []) {
      const g = s.group ?? "";
      const list = groups.get(g) ?? [];
      list.push(s);
      groups.set(g, list);
    }
    return [...groups.entries()];
  }, [settings]);

  const setValue = (id: string, v: string) => setValues((prev) => ({ ...prev, [id]: v }));

  const handleApply = async () => {
    if (!onApplyManifest || changed.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onApplyManifest(JSON.stringify(changed));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't apply settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-3 border-b border-border flex-shrink-0">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
          {capability.tabLabel ?? "Settings"}
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || saving}
            className="px-3 py-1.5 text-xs text-on-surface-tertiary hover:text-white border border-border-strong rounded-md transition-colors disabled:opacity-40"
          >
            Reload
          </button>
          {onApplyManifest && (
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={changed.length === 0 || saving || loading}
              className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors disabled:opacity-40"
            >
              {saving ? "Applying…" : changed.length > 0 ? `Apply (${changed.length})` : "Apply"}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5">
        {capability.description && (
          <p className="text-xs text-on-surface-muted mb-4">{capability.description}</p>
        )}
        {error && (
          <ErrorNotice
            message={error}
            className="mb-4 rounded bg-red-100 dark:bg-red-900/20 px-3 py-2"
            textClassName="text-xs text-red-500 dark:text-red-300 leading-relaxed break-words"
          />
        )}
        {loading ? (
          <p className="text-sm text-on-surface-muted animate-pulse">Loading settings…</p>
        ) : settings && settings.length > 0 ? (
          <div className="space-y-6">
            {grouped.map(([groupName, rows]) => (
              <div key={groupName || "default"}>
                {groupName && (
                  <h4 className="text-[11px] font-semibold uppercase tracking-wide text-on-surface-faint mb-2">
                    {groupName}
                  </h4>
                )}
                <div className="border border-border rounded-lg divide-y divide-border overflow-hidden">
                  {rows.map((s) => (
                    <SettingRow
                      key={s.id}
                      descriptor={s}
                      value={values[s.id] ?? s.value}
                      dirty={s.control !== "readonly" && values[s.id] !== initial[s.id]}
                      onChange={(v) => setValue(s.id, v)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          !error && <p className="text-sm text-on-surface-faint">No settings.</p>
        )}
      </div>
    </div>
  );
}

function SettingRow({
  descriptor,
  value,
  dirty,
  onChange,
}: {
  descriptor: SettingDescriptor;
  value: string;
  dirty: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm text-on-surface-secondary flex items-center gap-2">
          {descriptor.label}
          {dirty && <span className="w-1.5 h-1.5 rounded-full bg-blue-400" aria-label="changed" />}
        </div>
        {descriptor.description && (
          <div className="text-xs text-on-surface-faint mt-0.5">{descriptor.description}</div>
        )}
      </div>
      <div className="flex-shrink-0">
        <SettingControl descriptor={descriptor} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

function SettingControl({
  descriptor,
  value,
  onChange,
}: {
  descriptor: SettingDescriptor;
  value: string;
  onChange: (v: string) => void;
}) {
  const fieldClass =
    "px-2.5 py-1.5 text-sm bg-surface-overlay border border-border rounded-md text-on-surface focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-500";

  switch (descriptor.control) {
    case "toggle": {
      const on = value === "on" || value === "true";
      return (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={descriptor.label}
          onClick={() => onChange(on ? "off" : "on")}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            on ? "bg-blue-600" : "bg-surface-sunken border border-border-strong"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              on ? "translate-x-4" : "translate-x-1"
            }`}
          />
        </button>
      );
    }
    case "select":
      return (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={descriptor.label}
          className={fieldClass}
        >
          {(descriptor.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "number":
      return (
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={descriptor.label}
          className={`${fieldClass} w-28 text-right`}
        />
      );
    case "text":
      return (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={descriptor.label}
          className={`${fieldClass} w-48 font-mono text-xs`}
        />
      );
    case "readonly":
    default:
      return (
        <span className="text-xs font-mono text-on-surface-faint" title="Managed by the provider">
          {value || "—"}
        </span>
      );
  }
}
