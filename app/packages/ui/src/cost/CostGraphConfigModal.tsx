import { useEffect, useId, useState } from "react";
import { T, Var, msg, useGT, useMessages } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";
import {
  COST_BASES,
  COST_BASIS_LABELS,
  COST_BINNING_LABELS as BINNING_LABELS,
  COST_BINNINGS,
  COST_CHART_TYPE_LABELS as CHART_TYPE_LABELS,
  COST_CHART_TYPES,
  COST_DIMENSIONS,
  COST_RANGE_PRESET_LABELS as PRESET_LABELS,
  COST_RANGE_PRESETS,
  costGraphConfigSchema,
  type CostBasis,
  type BusinessMetric,
  type CostGraphConfig,
  UNIT_COST_MODES,
  UNIT_COST_MODE_LABELS,
  type CostScenarioModel,
} from "./config.js";
import type { CostDimensionOption } from "./config.js";
import type { CostApi } from "./types.js";

import { Modal } from "../components/Modal.js";
import { selectBaseClass, selectClass, labelClass } from "./form-styles.js";
import { DIMENSION_LABELS, CostFilterEditor } from "./CostFilterEditor.js";

// The labels and the new-widget defaults live in client-core: mobile authors
// the same widgets and can't import this package.
export { DEFAULT_COST_GRAPH_CONFIG } from "./config.js";

/**
 * Whether the amortized cost basis is worth offering: true once any connected
 * account's plugin declares `amortization`.
 *
 * Offering it unconditionally would be a lie by omission. Without a provider
 * that reports an amortized number, every row falls back to its cash amount and
 * the two options draw the identical graph: a user who switched and saw
 * nothing change would reasonably conclude the feature is broken rather than
 * that their providers don't report it.
 *
 * A failed status load reads as "unavailable" rather than blocking the editor.
 * The one thing that always keeps the control visible is an already-selected
 * amortized basis (`force`): a widget must never lose a setting because the
 * status call happened to fail while it was being edited.
 */
export function useCostBasisChoice(
  api: CostApi,
  force = false,
): { available: boolean; loading: boolean } {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .loadCostStatus()
      .then((statuses) => {
        if (!cancelled) setAvailable(statuses.some((s) => s.supportsCosts && s.amortization));
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return { available: force || available === true, loading: available === null };
}

/** The Cost basis select, shared by the graph and budget editors. */
export function CostBasisField({
  id,
  value,
  onChange,
  available,
  hint,
}: {
  id: string;
  value: CostBasis | undefined;
  onChange: (basis: CostBasis) => void;
  available: boolean;
  hint: string;
}) {
  const gt = useGT();
  const gtData = useDataString();
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {gt("Cost basis")}
      </label>
      <select
        id={id}
        className={selectClass}
        value={value ?? "cash"}
        disabled={!available}
        onChange={(e) => onChange(e.target.value as CostBasis)}
      >
        {COST_BASES.map((b) => (
          <option key={b} value={b}>
            {gtData(COST_BASIS_LABELS[b])}
          </option>
        ))}
      </select>
      {!available && <p className="mt-1 text-xs text-on-surface-faint">{hint}</p>}
    </div>
  );
}

/**
 * Why the basis select is disabled: one sentence, same words everywhere.
 *
 * msg() rather than t(): this is module scope, where t() is forbidden (it has
 * no request/render context to resolve against). Render it through
 * `useMessages()`, as both call sites do.
 */
export const COST_BASIS_UNAVAILABLE_HINT = msg(
  "No connected provider reports amortized cost, so every amount here is what was charged.",
);

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
  const gt = useGT();
  const gtData = useDataString();
  const m = useMessages();
  const uid = useId();
  const [title, setTitle] = useState(initialTitle);
  const [config, setConfig] = useState<CostGraphConfig>(initialConfig);
  const [tagKeys, setTagKeys] = useState<CostDimensionOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * A filter the text editor could not compile. Saving is blocked while it is
   * set: the config still holds the last query that parsed, so saving now would
   * silently store a different filter from the one on screen.
   */
  const [filterError, setFilterError] = useState<string | null>(null);
  const basis = useCostBasisChoice(api, initialConfig.costBasis === "amortized");
  /**
   * The org's business metrics, for the unit-cost picker. `null` while loading
   * or when the host hasn't wired the endpoint: in both cases the picker is
   * left out rather than offered empty, which would read as "you have none".
   */
  const [metrics, setMetrics] = useState<BusinessMetric[] | null>(null);
  const loadMetrics = api.listBusinessMetrics;
  useEffect(() => {
    if (!loadMetrics) return;
    let cancelled = false;
    loadMetrics()
      .then((next) => {
        if (!cancelled) setMetrics(next);
      })
      .catch(() => {
        if (!cancelled) setMetrics([]);
      });
    return () => {
      cancelled = true;
    };
  }, [loadMetrics]);

  const unitCostMetric = metrics?.find((m) => m.id === config.unitCostMetricId) ?? null;

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
    if (filterError) {
      setError(gt("Fix the filter query before saving."));
      return;
    }
    const cleaned = {
      ...config,
      filters: config.filters.filter((f) => f.values.length > 0),
    };
    const parsed = costGraphConfigSchema.safeParse(cleaned);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? gt("Invalid configuration"));
      return;
    }
    if (parsed.data.groupBy === "tag" && !parsed.data.groupByTagKey) {
      setError(gt("Choose a tag key to group by"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(title, parsed.data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} ariaLabel={gt("Cost graph")}>
      <div className="w-[32rem] max-w-[90vw] rounded-2xl border border-border bg-surface-raised p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-on-surface mb-4">{gt("Cost graph")}</h2>

        <div className="space-y-4">
          <div>
            <label htmlFor={`${uid}-title`} className={labelClass}>
              {gt("Title")}
            </label>
            <input
              id={`${uid}-title`}
              className={selectClass}
              placeholder={gt("e.g. Cloud spend by provider")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${uid}-chart-type`} className={labelClass}>
                {gt("Chart type")}
              </label>
              <select
                id={`${uid}-chart-type`}
                className={selectClass}
                value={config.chartType}
                onChange={(e) => set({ chartType: e.target.value as CostGraphConfig["chartType"] })}
              >
                {COST_CHART_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {gtData(CHART_TYPE_LABELS[t])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-binning`} className={labelClass}>
                {gt("Binning")}
              </label>
              <select
                id={`${uid}-binning`}
                className={selectClass}
                value={config.binning}
                onChange={(e) => set({ binning: e.target.value as CostGraphConfig["binning"] })}
              >
                {COST_BINNINGS.map((b) => (
                  <option key={b} value={b}>
                    {gtData(BINNING_LABELS[b])}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-date-range`} className={labelClass}>
                {gt("Date range")}
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
                    {gtData(PRESET_LABELS[p])}
                  </option>
                ))}
                <option value="custom">{gt("Custom…")}</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${uid}-group-by`} className={labelClass}>
                {gt("Group by")}
              </label>
              <select
                id={`${uid}-group-by`}
                className={selectClass}
                value={config.groupBy}
                onChange={(e) => set({ groupBy: e.target.value as CostGraphConfig["groupBy"] })}
              >
                <option value="none">{gt("None")}</option>
                {COST_DIMENSIONS.map((d) => (
                  <option key={d} value={d}>
                    {gtData(DIMENSION_LABELS[d])}
                  </option>
                ))}
              </select>
            </div>
            <CostBasisField
              id={`${uid}-cost-basis`}
              value={config.costBasis}
              onChange={(costBasis) => set({ costBasis })}
              available={basis.available}
              hint={m(COST_BASIS_UNAVAILABLE_HINT)}
            />
          </div>

          {/*
            Unit costs are a *mode* of this graph, not a second chart type: the
            date range, binning, filters and cost basis above all still describe
            the numerator. Only the four options that presuppose a stack of
            series stop applying, and the note below says so rather than leaving
            a user to wonder why Group by did nothing.
          */}
          {metrics !== null && metrics.length > 0 && (
            <div className="rounded-lg border border-border p-3">
              <label htmlFor={`${uid}-unit-metric`} className={labelClass}>
                {gt("Divide by a business metric")}
              </label>
              <div className="grid grid-cols-2 gap-3">
                <select
                  id={`${uid}-unit-metric`}
                  className={selectClass}
                  value={config.unitCostMetricId ?? ""}
                  onChange={(e) =>
                    set(
                      e.target.value
                        ? { unitCostMetricId: e.target.value }
                        : // Clear the mode with the metric: a stored `margin`
                          // with no metric would be meaningless, and would come
                          // back the moment a metric was picked again.
                          { unitCostMetricId: undefined, unitCostMode: undefined },
                    )
                  }
                >
                  <option value="">{gt("No — show spend")}</option>
                  {metrics.map((m) => (
                    <option key={m.id} value={m.id}>
                      {gt("{name} (per {unit})", { name: gtData(m.name), unit: gtData(m.unit) })}
                    </option>
                  ))}
                </select>
                {config.unitCostMetricId && (
                  <select
                    className={selectClass}
                    aria-label={gt("Unit cost mode")}
                    value={config.unitCostMode ?? "unit_cost"}
                    onChange={(e) =>
                      set({ unitCostMode: e.target.value as CostGraphConfig["unitCostMode"] })
                    }
                  >
                    {UNIT_COST_MODES.map((mode) => (
                      <option
                        key={mode}
                        value={mode}
                        // Margin subtracts money from money. Offering it for a
                        // count metric would produce a plausible-looking number
                        // that means nothing, so the option is disabled here and
                        // refused by the server as well.
                        disabled={mode === "margin" && unitCostMetric?.kind !== "currency"}
                      >
                        {gtData(UNIT_COST_MODE_LABELS[mode])}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {config.unitCostMetricId && (
                <T>
                  <p className="mt-2 text-[11px] text-on-surface-faint">
                    The chart shows{" "}
                    <Var>
                      {config.unitCostMode === "margin"
                        ? gt("margin against this metric")
                        : gt("cost per {unit}", { unit: gtData(unitCostMetric?.unit ?? "unit") })}
                    </Var>
                    . Group by, top groups, comparison and forecast don&rsquo;t apply — a per-group
                    ratio would need a per-group metric, and a period with no reported value is
                    drawn as a gap rather than as zero.
                    <Var>
                      {unitCostMetric && unitCostMetric.kind !== "currency" ? (
                        <>
                          {" "}
                          {gt("Margin needs a revenue metric, so it is unavailable for this one.")}
                        </>
                      ) : null}
                    </Var>
                  </p>
                </T>
              )}
            </div>
          )}

          {config.dateRange.kind === "absolute" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${uid}-from`} className={labelClass}>
                  {gt("From")}
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
                  {gt("To")}
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
                {gt("Tag key")}
              </label>
              <select
                id={`${uid}-tag-key`}
                className={selectClass}
                value={config.groupByTagKey ?? ""}
                onChange={(e) => set({ groupByTagKey: e.target.value })}
              >
                <option value="">{gt("Choose a tag key…")}</option>
                {tagKeys.map((k) => (
                  <option key={k.value} value={k.value}>
                    {gtData(k.label)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div role="group" aria-labelledby={`${uid}-filters-label`}>
            <span id={`${uid}-filters-label`} className={labelClass}>
              {gt("Filters")}
            </span>
            <CostFilterEditor
              filters={config.filters}
              onChange={(filters) => set({ filters })}
              api={api}
              onErrorChange={setFilterError}
              savedFilterId={config.savedFilterId}
              onSavedFilterChange={(savedFilterId) => set({ savedFilterId })}
            />
          </div>

          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2">
              <label htmlFor={`${uid}-top-n`} className="text-xs text-on-surface-secondary">
                {gt("Top groups")}
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
              {gt("Compare previous period")}
            </label>
            <label className="flex items-center gap-2 text-xs text-on-surface-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={config.showForecast}
                onChange={(e) => set({ showForecast: e.target.checked })}
              />
              {gt("Forecast")}
            </label>
          </div>

          {/* The scenario picker. Only offered alongside the forecast, because
              a scenario adjusts the projected region and there is nothing to
              adjust without one, and clearing the forecast clears the model
              rather than storing a selection that would never be drawn. */}
          <ScenarioModelPicker
            api={api}
            value={config.scenarioModelId ?? null}
            enabled={config.showForecast}
            onChange={(scenarioModelId) =>
              set(scenarioModelId ? { scenarioModelId } : { scenarioModelId: undefined })
            }
          />

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-sm text-on-surface-secondary hover:bg-surface-sunken transition-colors"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || filterError !== null}
              className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
            >
              {saving ? gt("Saving…") : gt("Save")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Pick a scenario model to overlay on this graph's forecast.
 *
 * Rendered only when the host wired `listScenarioModels` *and* the org has at
 * least one model: an empty picker reads as "this feature is broken" rather
 * than "you have not made one yet", and the Costs panel is where models are
 * made.
 *
 * Disabled (and cleared) when the forecast is off. Storing a model on a graph
 * that draws no projection would be a setting with no effect, and a setting
 * with no effect is a setting somebody will later swear was applied.
 */
function ScenarioModelPicker({
  api,
  value,
  enabled,
  onChange,
}: {
  api: CostApi;
  value: string | null;
  enabled: boolean;
  onChange: (scenarioModelId: string | null) => void;
}) {
  const gt = useGT();
  const gtData = useDataString();
  const uid = useId();
  const [models, setModels] = useState<CostScenarioModel[] | null>(null);
  const load = api.listScenarioModels;

  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    load()
      .then((next) => {
        if (!cancelled) setModels(next);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Clearing the forecast clears the selection, so the stored config never
  // carries a model the card would not draw.
  useEffect(() => {
    if (!enabled && value) onChange(null);
  }, [enabled, value, onChange]);

  if (!load || !models || models.length === 0) return null;
  const selected = models.find((m) => m.id === value) ?? null;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${uid}-scenario`} className="text-xs text-on-surface-secondary">
        {gt("Scenario")}
      </label>
      <select
        id={`${uid}-scenario`}
        className={selectBaseClass}
        disabled={!enabled}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{gt("None — trend only")}</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {gtData(model.name)}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-on-surface-faint">
        {!enabled
          ? gt(
              "Turn on Forecast to overlay a scenario — there is no projection to adjust otherwise.",
            )
          : selected
            ? gt(
                'The card draws the trend and "{name}" as two separate dashed lines, and says so under its title.',
                { name: gtData(selected.name) },
              )
            : gt(
                "Known future cost the trend can\u2019t see, drawn beside the forecast rather than instead of it.",
              )}
      </p>
    </div>
  );
}

export { DIMENSION_LABELS, CostFilterRows, CostFilterEditor } from "./CostFilterEditor.js";
export type { CostFilterEditorProps } from "./CostFilterEditor.js";
