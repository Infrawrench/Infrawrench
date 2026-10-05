import { useEffect, useId, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";
import {
  UNIT_COST_MODES,
  UNIT_COST_MODE_LABELS,
  UNIT_COST_SCALES,
  UNIT_COST_SCALE_LABELS,
  unitCostModeNeedsMetric,
  type BusinessMetric,
  type BusinessMetricLabelSummary,
  type CostGraphConfig,
  type UnitCostMode,
} from "./config.js";
import type { CostApi } from "./types.js";
import { labelClass, selectClass } from "./form-styles.js";

/**
 * The unit-cost half of the cost graph editor: which calculation, against
 * which metric (or usage unit), at what scale, and which metric labels to
 * filter and split by.
 *
 * A calculation is a *mode* of the graph, not a second chart type: the date
 * range, binning, filters and cost basis above it all still describe the spend
 * side. Every picker here is filled from the API (metrics, usage units, label
 * keys and values), so nobody has to know a provider's spelling of `GB-Mo` or
 * which labels a workflow has been writing.
 */
export interface UnitCostConfigFieldsProps {
  api: CostApi;
  config: CostGraphConfig;
  set: (patch: Partial<CostGraphConfig>) => void;
  /** The org's metrics; null while loading or when the host has no loader. */
  metrics: BusinessMetric[] | null;
}

type UsageUnit = { unit: string; usage: number; services: string[] };

/** Every unit-cost field cleared: the graph goes back to plain spend. */
const CLEARED: Partial<CostGraphConfig> = {
  unitCostMetricId: undefined,
  unitCostMode: undefined,
  unitCostScale: undefined,
  unitCostUsageUnit: undefined,
  unitCostLabelFilters: undefined,
  unitCostGroupByLabel: undefined,
};

export function UnitCostConfigFields({ api, config, set, metrics }: UnitCostConfigFieldsProps) {
  const gt = useGT();
  const gtData = useDataString();
  const uid = useId();

  const mode: UnitCostMode | null = config.unitCostMetricId
    ? (config.unitCostMode ?? "unit_cost")
    : config.unitCostMode === "usage_unit_cost"
      ? "usage_unit_cost"
      : null;
  const metric = metrics?.find((m) => m.id === config.unitCostMetricId) ?? null;
  const ratio = mode !== null && mode !== "raw_metric";

  const [usageUnits, setUsageUnits] = useState<UsageUnit[] | null>(null);
  const loadUsageUnits = api.listUsageUnits;
  const canUsage = Boolean(api.queryUsageUnitCosts && loadUsageUnits);
  useEffect(() => {
    if (mode !== "usage_unit_cost" || !loadUsageUnits || usageUnits !== null) return;
    let cancelled = false;
    loadUsageUnits()
      .then((next) => {
        if (!cancelled) setUsageUnits(next);
      })
      .catch(() => {
        if (!cancelled) setUsageUnits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, loadUsageUnits, usageUnits]);

  const [labels, setLabels] = useState<BusinessMetricLabelSummary[] | null>(null);
  const loadLabels = api.listBusinessMetricLabels;
  const metricId = config.unitCostMetricId;
  useEffect(() => {
    setLabels(null);
    if (!metricId || !loadLabels) return;
    let cancelled = false;
    loadLabels(metricId)
      .then((next) => {
        if (!cancelled) setLabels(next);
      })
      .catch(() => {
        if (!cancelled) setLabels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [metricId, loadLabels]);

  const hasMetrics = metrics !== null && metrics.length > 0;
  if (!hasMetrics && !canUsage) return null;

  const offered = UNIT_COST_MODES.filter((m) => (m === "usage_unit_cost" ? canUsage : hasMetrics));

  const chooseMode = (next: string) => {
    if (!next) {
      set(CLEARED);
      return;
    }
    const nextMode = next as UnitCostMode;
    if (!unitCostModeNeedsMetric(nextMode)) {
      set({
        ...CLEARED,
        // A running total of a ratio means nothing; see costDisplayProblem.
        cumulative: undefined,
        unitCostMode: "usage_unit_cost",
        unitCostUsageUnit: config.unitCostUsageUnit,
        unitCostScale: config.unitCostScale,
      });
      return;
    }
    const keepMetric =
      metrics?.find((m) => m.id === config.unitCostMetricId) ??
      (nextMode === "margin" ? metrics?.find((m) => m.kind === "currency") : metrics?.[0]);
    set({
      cumulative: undefined,
      unitCostMode: nextMode === "unit_cost" ? undefined : nextMode,
      unitCostMetricId: keepMetric?.id,
      unitCostUsageUnit: undefined,
      ...(nextMode === "margin" ? { unitCostScale: undefined } : {}),
    });
  };

  // The label the filter row edits: the first stored filter, or nothing yet.
  const labelFilter = config.unitCostLabelFilters?.[0];
  const filterSummary = labels?.find((l) => l.key === labelFilter?.key) ?? null;
  const labelUsable = (l: BusinessMetricLabelSummary) => !ratio || l.mapping !== null;

  return (
    <div className="rounded-lg border border-border p-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${uid}-mode`} className={labelClass}>
            {gt("Calculation")}
          </label>
          <select
            id={`${uid}-mode`}
            className={selectClass}
            value={mode ?? ""}
            onChange={(e) => chooseMode(e.target.value)}
          >
            <option value="">{gt("None — show spend")}</option>
            {offered.map((m) => (
              <option
                key={m}
                value={m}
                // Margin subtracts money from money; with no revenue metric
                // there is nothing it could honestly compute.
                disabled={m === "margin" && !metrics?.some((x) => x.kind === "currency")}
              >
                {gtData(UNIT_COST_MODE_LABELS[m])}
              </option>
            ))}
          </select>
        </div>

        {mode !== null && mode !== "usage_unit_cost" && hasMetrics && (
          <div>
            <label htmlFor={`${uid}-metric`} className={labelClass}>
              {gt("Business metric")}
            </label>
            <select
              id={`${uid}-metric`}
              className={selectClass}
              value={config.unitCostMetricId ?? ""}
              onChange={(e) =>
                set({
                  unitCostMetricId: e.target.value || undefined,
                  // Labels belong to a metric; another metric's are not these.
                  unitCostLabelFilters: undefined,
                  unitCostGroupByLabel: undefined,
                })
              }
            >
              {metrics!.map((m) => (
                <option
                  key={m.id}
                  value={m.id}
                  disabled={mode === "margin" && m.kind !== "currency"}
                >
                  {gt("{name} (per {unit})", { name: gtData(m.name), unit: gtData(m.unit) })}
                </option>
              ))}
            </select>
          </div>
        )}

        {mode === "usage_unit_cost" && (
          <div>
            <label htmlFor={`${uid}-usage-unit`} className={labelClass}>
              {gt("Usage unit")}
            </label>
            <select
              id={`${uid}-usage-unit`}
              className={selectClass}
              value={config.unitCostUsageUnit ?? ""}
              onChange={(e) => set({ unitCostUsageUnit: e.target.value || undefined })}
            >
              <option value="">
                {usageUnits === null ? gt("Loading units…") : gt("Choose a unit")}
              </option>
              {(usageUnits ?? []).map((u) => (
                <option key={u.unit} value={u.unit}>
                  {u.services.length > 0
                    ? `${u.unit} · ${u.services.slice(0, 3).join(", ")}`
                    : u.unit}
                </option>
              ))}
              {config.unitCostUsageUnit &&
                usageUnits !== null &&
                !usageUnits.some((u) => u.unit === config.unitCostUsageUnit) && (
                  <option value={config.unitCostUsageUnit}>{config.unitCostUsageUnit}</option>
                )}
            </select>
          </div>
        )}

        {mode !== null && mode !== "margin" && (
          <div>
            <label htmlFor={`${uid}-scale`} className={labelClass}>
              {mode === "raw_metric" ? gt("Show in") : gt("Scale")}
            </label>
            <select
              id={`${uid}-scale`}
              className={selectClass}
              value={String(config.unitCostScale ?? 1)}
              onChange={(e) => {
                const scale = Number(e.target.value) as CostGraphConfig["unitCostScale"];
                set({ unitCostScale: scale === 1 ? undefined : scale });
              }}
            >
              {UNIT_COST_SCALES.map((s) => (
                <option key={s} value={String(s)}>
                  {gtData(UNIT_COST_SCALE_LABELS[`${s}`])}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {mode !== null && mode !== "usage_unit_cost" && labels !== null && labels.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${uid}-group-label`} className={labelClass}>
              {gt("Split by label")}
            </label>
            <select
              id={`${uid}-group-label`}
              className={selectClass}
              value={config.unitCostGroupByLabel ?? ""}
              onChange={(e) => set({ unitCostGroupByLabel: e.target.value || undefined })}
            >
              <option value="">{gt("No split")}</option>
              {labels.map((l) => (
                <option key={l.key} value={l.key} disabled={!labelUsable(l)}>
                  {labelUsable(l) ? l.key : gt("{label} (not mapped to spend)", { label: l.key })}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-filter-label`} className={labelClass}>
              {gt("Only label")}
            </label>
            <div className="flex gap-2">
              <select
                id={`${uid}-filter-label`}
                className={selectClass}
                value={labelFilter?.key ?? ""}
                onChange={(e) =>
                  set({
                    unitCostLabelFilters: e.target.value
                      ? [{ key: e.target.value, op: "in", values: [] }]
                      : undefined,
                  })
                }
              >
                <option value="">{gt("All values")}</option>
                {labels.map((l) => (
                  <option key={l.key} value={l.key} disabled={!labelUsable(l)}>
                    {labelUsable(l) ? l.key : gt("{label} (not mapped to spend)", { label: l.key })}
                  </option>
                ))}
              </select>
              {labelFilter && (
                <select
                  className={selectClass}
                  aria-label={gt("Label filter operator")}
                  value={labelFilter.op}
                  onChange={(e) =>
                    set({
                      unitCostLabelFilters: [
                        { ...labelFilter, op: e.target.value === "not_in" ? "not_in" : "in" },
                      ],
                    })
                  }
                >
                  <option value="in">{gt("is")}</option>
                  <option value="not_in">{gt("is not")}</option>
                </select>
              )}
            </div>
            {labelFilter && filterSummary && (
              <div
                className="mt-2 max-h-28 overflow-y-auto rounded border border-border p-2 space-y-1"
                role="group"
                aria-label={gt("Label values")}
              >
                {filterSummary.values.map((v) => {
                  const checked = labelFilter.values.includes(v);
                  return (
                    <label key={v} className="flex items-center gap-2 text-xs text-on-surface">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          set({
                            unitCostLabelFilters: [
                              {
                                ...labelFilter,
                                values: checked
                                  ? labelFilter.values.filter((x) => x !== v)
                                  : [...labelFilter.values, v],
                              },
                            ],
                          })
                        }
                      />
                      {v}
                    </label>
                  );
                })}
                {filterSummary.truncated && (
                  <p className="text-[11px] text-on-surface-faint">
                    {gt("Showing the first {count} values.", {
                      count: filterSummary.values.length,
                    })}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {mode !== null && (
        <T>
          <p className="text-[11px] text-on-surface-faint">
            Group by, top groups, comparison and forecast don&rsquo;t apply to a calculation, and a
            period with nothing to divide by is drawn as a gap rather than as zero.{" "}
            <Var>
              {ratio && labels !== null && labels.some((l) => l.mapping === null)
                ? gt(
                    "Labels not mapped to a cost dimension can only be used with the raw metric: map them on the metric to compute a ratio per value.",
                  )
                : ""}
            </Var>
            <Var>
              {metric && metric.kind !== "currency" && mode !== "raw_metric"
                ? ` ${gt("Margin needs a revenue metric.")}`
                : ""}
            </Var>
          </p>
        </T>
      )}
    </div>
  );
}
