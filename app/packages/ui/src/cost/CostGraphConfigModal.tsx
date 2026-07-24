import { useEffect, useId, useState } from "react";
import {
  COST_BINNINGS,
  COST_CHART_TYPES,
  COST_DIMENSIONS,
  COST_RANGE_PRESETS,
  costGraphConfigSchema,
  type CostFilter,
  type CostGraphConfig,
} from "./config.js";
import type { CostApi, CostDimensionOption } from "./types.js";

const CHART_TYPE_LABELS: Record<(typeof COST_CHART_TYPES)[number], string> = {
  stacked_bar: "Stacked bar",
  multi_bar: "Multi bar",
  line: "Line",
  area: "Area",
  pie: "Pie",
};

const BINNING_LABELS: Record<(typeof COST_BINNINGS)[number], string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  cumulative: "Cumulative",
};

const PRESET_LABELS: Record<(typeof COST_RANGE_PRESETS)[number], string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  mtd: "Month to date",
  last_month: "Last month",
  qtd: "Quarter to date",
  ytd: "Year to date",
  "12m": "Last 12 months",
};

const DIMENSION_LABELS: Record<(typeof COST_DIMENSIONS)[number], string> = {
  provider: "Provider",
  account: "Account",
  service: "Service",
  region: "Region",
  resource: "Resource",
  tag: "Tag",
};

export const DEFAULT_COST_GRAPH_CONFIG: CostGraphConfig = {
  version: 1,
  chartType: "stacked_bar",
  binning: "daily",
  dateRange: { kind: "relative", preset: "30d" },
  groupBy: "provider",
  filters: [],
  topN: 5,
  comparePreviousPeriod: false,
  showForecast: false,
};

const selectBaseClass =
  "rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const selectClass = `w-full ${selectBaseClass}`;
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

interface FilterRowEditorProps {
  filters: CostFilter[];
  onChange: (filters: CostFilter[]) => void;
  api: CostApi;
}

/** Filter rule rows shared by the graph and budget editors. */
export function CostFilterRows({ filters, onChange, api }: FilterRowEditorProps) {
  const [optionsByKey, setOptionsByKey] = useState<Record<string, CostDimensionOption[]>>({});

  const loadOptions = (dimension: string, tagKey?: string) => {
    const key = tagKey ? `${dimension}:${tagKey}` : dimension;
    if (optionsByKey[key]) return;
    void api
      .loadDimensionValues(dimension, tagKey)
      .then((values) => setOptionsByKey((prev) => ({ ...prev, [key]: values })))
      .catch(() => setOptionsByKey((prev) => ({ ...prev, [key]: [] })));
  };

  const update = (index: number, patch: Partial<CostFilter>) => {
    onChange(filters.map((f, i) => (i === index ? ({ ...f, ...patch } as CostFilter) : f)));
  };

  return (
    <div className="space-y-2">
      {filters.map((filter, i) => {
        const optKey = filter.tagKey ? `${filter.dimension}:${filter.tagKey}` : filter.dimension;
        const options = optionsByKey[optKey] ?? [];
        return (
          <div key={i} className="flex items-start gap-2">
            <select
              aria-label="Filter dimension"
              className={`${selectBaseClass} w-28 flex-shrink-0`}
              value={filter.dimension}
              onChange={(e) => {
                const dimension = e.target.value as CostFilter["dimension"];
                update(i, {
                  dimension,
                  values: [],
                  ...(dimension !== "tag" ? { tagKey: undefined } : {}),
                });
                if (dimension !== "tag") loadOptions(dimension);
              }}
            >
              {COST_DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {DIMENSION_LABELS[d]}
                </option>
              ))}
            </select>
            {filter.dimension === "tag" && (
              <input
                aria-label="Tag key"
                className={`${selectBaseClass} w-24 flex-shrink-0`}
                placeholder="tag key"
                value={filter.tagKey ?? ""}
                onChange={(e) => update(i, { tagKey: e.target.value })}
                onBlur={() => filter.tagKey && loadOptions("tag", filter.tagKey)}
              />
            )}
            <select
              aria-label="Filter operator"
              className={`${selectBaseClass} w-24 flex-shrink-0`}
              value={filter.op}
              onChange={(e) => update(i, { op: e.target.value as CostFilter["op"] })}
            >
              <option value="in">is</option>
              <option value="not_in">is not</option>
            </select>
            <select
              multiple
              aria-label="Filter values"
              className={`${selectBaseClass} min-w-0 flex-1 min-h-[4.5rem]`}
              value={filter.values}
              onFocus={() =>
                filter.dimension === "tag"
                  ? filter.tagKey && loadOptions("tag", filter.tagKey)
                  : loadOptions(filter.dimension)
              }
              onChange={(e) =>
                update(i, { values: [...e.target.selectedOptions].map((o) => o.value) })
              }
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              {options.length === 0 &&
                filter.values.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
            </select>
            <button
              type="button"
              onClick={() => onChange(filters.filter((_, j) => j !== i))}
              className="mt-1.5 text-on-surface-faint hover:text-on-surface-secondary text-xs"
              title="Remove filter"
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => onChange([...filters, { dimension: "provider", op: "in", values: [] }])}
        className="text-xs text-blue-400 hover:text-blue-300"
      >
        + Add filter
      </button>
    </div>
  );
}

export interface CostGraphConfigModalProps {
  /** Initial values; pass DEFAULT_COST_GRAPH_CONFIG for a new widget. */
  initialConfig: CostGraphConfig;
  initialTitle: string;
  api: CostApi;
  onSave: (title: string, config: CostGraphConfig) => Promise<void> | void;
  onClose: () => void;
}

export function CostGraphConfigModal({
  initialConfig,
  initialTitle,
  api,
  onSave,
  onClose,
}: CostGraphConfigModalProps) {
  const uid = useId();
  const [title, setTitle] = useState(initialTitle);
  const [config, setConfig] = useState<CostGraphConfig>(initialConfig);
  const [tagKeys, setTagKeys] = useState<CostDimensionOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (config.groupBy === "tag" && tagKeys.length === 0) {
      void api
        .loadDimensionValues("tag-keys")
        .then(setTagKeys)
        .catch(() => setTagKeys([]));
    }
  }, [api, config.groupBy, tagKeys.length]);

  const set = (patch: Partial<CostGraphConfig>) =>
    setConfig((prev) => ({ ...prev, ...patch }) as CostGraphConfig);

  const save = async () => {
    const cleaned = {
      ...config,
      filters: config.filters.filter((f) => f.values.length > 0),
    };
    const parsed = costGraphConfigSchema.safeParse(cleaned);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid configuration");
      return;
    }
    if (parsed.data.groupBy === "tag" && !parsed.data.groupByTagKey) {
      setError("Choose a tag key to group by");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(title, parsed.data);
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
        <h2 className="text-lg font-semibold text-on-surface mb-4">Cost graph</h2>

        <div className="space-y-4">
          <div>
            <label htmlFor={`${uid}-title`} className={labelClass}>
              Title
            </label>
            <input
              id={`${uid}-title`}
              className={selectClass}
              placeholder="e.g. Cloud spend by provider"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${uid}-chart-type`} className={labelClass}>
                Chart type
              </label>
              <select
                id={`${uid}-chart-type`}
                className={selectClass}
                value={config.chartType}
                onChange={(e) => set({ chartType: e.target.value as CostGraphConfig["chartType"] })}
              >
                {COST_CHART_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CHART_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-binning`} className={labelClass}>
                Binning
              </label>
              <select
                id={`${uid}-binning`}
                className={selectClass}
                value={config.binning}
                onChange={(e) => set({ binning: e.target.value as CostGraphConfig["binning"] })}
              >
                {COST_BINNINGS.map((b) => (
                  <option key={b} value={b}>
                    {BINNING_LABELS[b]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-date-range`} className={labelClass}>
                Date range
              </label>
              <select
                id={`${uid}-date-range`}
                className={selectClass}
                value={config.dateRange.kind === "relative" ? config.dateRange.preset : "custom"}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v !== "custom") {
                    set({
                      dateRange: {
                        kind: "relative",
                        preset: v as (typeof COST_RANGE_PRESETS)[number],
                      },
                    });
                  } else {
                    const today = new Date().toISOString().slice(0, 10);
                    set({ dateRange: { kind: "absolute", from: today, to: today } });
                  }
                }}
              >
                {COST_RANGE_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {PRESET_LABELS[p]}
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-group-by`} className={labelClass}>
                Group by
              </label>
              <select
                id={`${uid}-group-by`}
                className={selectClass}
                value={config.groupBy}
                onChange={(e) => set({ groupBy: e.target.value as CostGraphConfig["groupBy"] })}
              >
                <option value="none">None</option>
                {COST_DIMENSIONS.map((d) => (
                  <option key={d} value={d}>
                    {DIMENSION_LABELS[d]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {config.dateRange.kind === "absolute" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${uid}-from`} className={labelClass}>
                  From
                </label>
                <input
                  id={`${uid}-from`}
                  type="date"
                  className={selectClass}
                  value={config.dateRange.from}
                  onChange={(e) =>
                    set({
                      dateRange: {
                        kind: "absolute",
                        from: e.target.value,
                        to:
                          config.dateRange.kind === "absolute"
                            ? config.dateRange.to
                            : e.target.value,
                      },
                    })
                  }
                />
              </div>
              <div>
                <label htmlFor={`${uid}-to`} className={labelClass}>
                  To
                </label>
                <input
                  id={`${uid}-to`}
                  type="date"
                  className={selectClass}
                  value={config.dateRange.to}
                  onChange={(e) =>
                    set({
                      dateRange: {
                        kind: "absolute",
                        from:
                          config.dateRange.kind === "absolute"
                            ? config.dateRange.from
                            : e.target.value,
                        to: e.target.value,
                      },
                    })
                  }
                />
              </div>
            </div>
          )}

          {config.groupBy === "tag" && (
            <div>
              <label htmlFor={`${uid}-tag-key`} className={labelClass}>
                Tag key
              </label>
              <select
                id={`${uid}-tag-key`}
                className={selectClass}
                value={config.groupByTagKey ?? ""}
                onChange={(e) => set({ groupByTagKey: e.target.value })}
              >
                <option value="">Choose a tag key…</option>
                {tagKeys.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div role="group" aria-labelledby={`${uid}-filters-label`}>
            <span id={`${uid}-filters-label`} className={labelClass}>
              Filters
            </span>
            <CostFilterRows
              filters={config.filters}
              onChange={(filters) => set({ filters })}
              api={api}
            />
          </div>

          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2">
              <label htmlFor={`${uid}-top-n`} className="text-xs text-on-surface-secondary">
                Top groups
              </label>
              <input
                id={`${uid}-top-n`}
                type="number"
                min={1}
                max={15}
                className={`${selectBaseClass} w-16`}
                value={config.topN}
                onChange={(e) =>
                  set({ topN: Math.max(1, Math.min(15, Number(e.target.value) || 5)) })
                }
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-on-surface-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={config.comparePreviousPeriod}
                onChange={(e) => set({ comparePreviousPeriod: e.target.checked })}
              />
              Compare previous period
            </label>
            <label className="flex items-center gap-2 text-xs text-on-surface-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={config.showForecast}
                onChange={(e) => set({ showForecast: e.target.checked })}
              />
              Forecast
            </label>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

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
