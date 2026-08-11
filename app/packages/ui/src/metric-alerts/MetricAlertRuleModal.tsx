import { useEffect, useId, useMemo, useState } from "react";
import {
  DEFAULT_METRIC_ALERT_INPUT,
  METRIC_ALERT_COMPARATORS,
  METRIC_ALERT_LIMITS,
  metricAlertRuleInputSchema,
  type MetricAlertComparator,
  type MetricAlertRuleInput,
  type MetricAlertSelectorOptions,
  type MetricAlertSelectorPreview,
  type MetricSeriesKeyOption,
} from "./config.js";
import type { MetricAlertsClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

export { DEFAULT_METRIC_ALERT_INPUT };

export interface MetricAlertRuleModalProps {
  initialInput: MetricAlertRuleInput;
  client: MetricAlertsClient;
  onSave: (input: MetricAlertRuleInput) => Promise<void> | void;
  onClose: () => void;
}

/**
 * Create/edit form for one metric alert rule. The selector is pickers over
 * what the org actually has (plugins, types, tag keys), the metric key is a
 * picker over the series the selected resources really report, and the form
 * previews live how many resources the selector covers — nobody should have
 * to know internal ids or series labels.
 */
export function MetricAlertRuleModal({
  initialInput,
  client,
  onSave,
  onClose,
}: MetricAlertRuleModalProps) {
  const uid = useId();
  const [input, setInput] = useState<MetricAlertRuleInput>(initialInput);
  const [thresholdText, setThresholdText] = useState(String(initialInput.threshold));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // null = loading, the house convention.
  const [options, setOptions] = useState<MetricAlertSelectorOptions | null>(null);
  const [metricKeys, setMetricKeys] = useState<MetricSeriesKeyOption[] | null>(null);
  const [preview, setPreview] = useState<MetricAlertSelectorPreview | null>(null);

  const set = (patch: Partial<MetricAlertRuleInput>) =>
    setInput((prev) => ({ ...prev, ...patch }) as MetricAlertRuleInput);

  useEffect(() => {
    let cancelled = false;
    client
      .selectorOptions()
      .then((o) => {
        if (!cancelled) setOptions(o);
      })
      .catch(() => {
        if (!cancelled) setOptions({ plugins: [], tagKeys: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // The metric key picker follows the plugin/type selection: it offers only
  // series that resources of that shape actually reported recently.
  useEffect(() => {
    let cancelled = false;
    setMetricKeys(null);
    client
      .listMetricKeys({ pluginId: input.pluginId, resourceTypeId: input.resourceTypeId })
      .then((keys) => {
        if (!cancelled) setMetricKeys(keys);
      })
      .catch(() => {
        if (!cancelled) setMetricKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, input.pluginId, input.resourceTypeId]);

  // Live "who does this cover?" preview, debounced a touch for tag typing.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      client
        .previewSelector({
          pluginId: input.pluginId,
          resourceTypeId: input.resourceTypeId,
          tagKey: input.tagKey,
          tagValue: input.tagValue,
        })
        .then((p) => {
          if (!cancelled) setPreview(p);
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, input.pluginId, input.resourceTypeId, input.tagKey, input.tagValue]);

  const typeOptions = useMemo(() => {
    if (!options || !input.pluginId) return [];
    return options.plugins.find((p) => p.pluginId === input.pluginId)?.resourceTypeIds ?? [];
  }, [options, input.pluginId]);

  const selectedKey = metricKeys?.find((k) => k.label === input.metricKey);

  const save = async () => {
    const threshold = Number(thresholdText);
    if (!Number.isFinite(threshold)) {
      setError("Enter a numeric threshold");
      return;
    }
    const parsed = metricAlertRuleInputSchema.safeParse({ ...input, threshold });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid rule");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed.data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-border bg-surface-raised p-5 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-on-surface mb-1">Metric alert rule</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          Fires when a metric breaches the threshold for the whole window, on every resource the
          selector matches — including ones created after the rule.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor={`${uid}-name`} className={labelClass}>
              Name
            </label>
            <input
              id={`${uid}-name`}
              className={inputClass}
              placeholder="e.g. High CPU on production VMs"
              maxLength={METRIC_ALERT_LIMITS.maxNameLength}
              value={input.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>

          <div role="group" aria-labelledby={`${uid}-selector-label`}>
            <span id={`${uid}-selector-label`} className={labelClass}>
              Resources (matched by query, not by id — all resources when empty)
            </span>
            <div className="grid grid-cols-2 gap-3">
              <select
                aria-label="Provider"
                className={inputClass}
                value={input.pluginId ?? ""}
                onChange={(e) => set({ pluginId: e.target.value || null, resourceTypeId: null })}
              >
                <option value="">Any provider</option>
                {(options?.plugins ?? []).map((p) => (
                  <option key={p.pluginId} value={p.pluginId}>
                    {p.pluginId}
                  </option>
                ))}
              </select>
              <select
                aria-label="Resource type"
                className={inputClass}
                value={input.resourceTypeId ?? ""}
                disabled={!input.pluginId}
                onChange={(e) => set({ resourceTypeId: e.target.value || null })}
              >
                <option value="">Any type</option>
                {typeOptions.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                aria-label="Tag key"
                className={inputClass}
                value={input.tagKey ?? ""}
                onChange={(e) =>
                  set({
                    tagKey: e.target.value || null,
                    ...(e.target.value ? {} : { tagValue: null }),
                  })
                }
              >
                <option value="">Any tag</option>
                {(options?.tagKeys ?? []).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <input
                aria-label="Tag value"
                className={inputClass}
                placeholder="Any value"
                disabled={!input.tagKey}
                maxLength={METRIC_ALERT_LIMITS.maxTagLength}
                value={input.tagValue ?? ""}
                onChange={(e) => set({ tagValue: e.target.value || null })}
              />
            </div>
            {preview && (
              <p className="text-xs text-on-surface-faint mt-1.5">
                Matches {preview.matchingResourceCount} resource
                {preview.matchingResourceCount === 1 ? "" : "s"} right now
                {preview.sampleResourceNames.length > 0
                  ? ` — ${preview.sampleResourceNames.slice(0, 3).join(", ")}${
                      preview.matchingResourceCount > 3 ? "…" : ""
                    }`
                  : ""}
              </p>
            )}
          </div>

          <div>
            <label htmlFor={`${uid}-metric`} className={labelClass}>
              Metric
            </label>
            <select
              id={`${uid}-metric`}
              className={inputClass}
              value={input.metricKey}
              onChange={(e) => set({ metricKey: e.target.value })}
            >
              <option value="" disabled>
                {metricKeys === null
                  ? "Loading metrics…"
                  : metricKeys.length === 0
                    ? "No metrics reported yet for this selection"
                    : "Pick a metric"}
              </option>
              {/* A saved key that stopped being reported stays selectable. */}
              {input.metricKey && !selectedKey && (
                <option value={input.metricKey}>{input.metricKey}</option>
              )}
              {(metricKeys ?? []).map((k) => (
                <option key={k.label} value={k.label}>
                  {k.label}
                  {k.unit ? ` (${k.unit})` : ""} · {k.resourceCount} resource
                  {k.resourceCount === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor={`${uid}-comparator`} className={labelClass}>
                Condition
              </label>
              <select
                id={`${uid}-comparator`}
                className={inputClass}
                value={input.comparator}
                onChange={(e) => set({ comparator: e.target.value as MetricAlertComparator })}
              >
                {METRIC_ALERT_COMPARATORS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-threshold`} className={labelClass}>
                Threshold{selectedKey?.unit ? ` (${selectedKey.unit})` : ""}
              </label>
              <input
                id={`${uid}-threshold`}
                type="number"
                step="any"
                className={inputClass}
                value={thresholdText}
                onChange={(e) => setThresholdText(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-for`} className={labelClass}>
                For (minutes)
              </label>
              <input
                id={`${uid}-for`}
                type="number"
                min={METRIC_ALERT_LIMITS.minForMinutes}
                max={METRIC_ALERT_LIMITS.maxForMinutes}
                className={inputClass}
                value={input.forMinutes}
                onChange={(e) =>
                  set({
                    forMinutes: Math.max(
                      METRIC_ALERT_LIMITS.minForMinutes,
                      Math.min(
                        METRIC_ALERT_LIMITS.maxForMinutes,
                        Math.round(Number(e.target.value) || METRIC_ALERT_LIMITS.minForMinutes),
                      ),
                    ),
                  })
                }
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <label htmlFor={`${uid}-cooldown`} className={labelClass}>
                Cooldown between alerts (minutes)
              </label>
              <input
                id={`${uid}-cooldown`}
                type="number"
                min={METRIC_ALERT_LIMITS.minCooldownMinutes}
                max={METRIC_ALERT_LIMITS.maxCooldownMinutes}
                className={inputClass}
                value={input.cooldownMinutes}
                onChange={(e) =>
                  set({
                    cooldownMinutes: Math.max(
                      METRIC_ALERT_LIMITS.minCooldownMinutes,
                      Math.min(
                        METRIC_ALERT_LIMITS.maxCooldownMinutes,
                        Math.round(Number(e.target.value) || 0),
                      ),
                    ),
                  })
                }
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-on-surface pb-1.5">
              <input
                type="checkbox"
                checked={input.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              Enabled
            </label>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-sm text-on-surface-secondary hover:bg-surface-sunken transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
