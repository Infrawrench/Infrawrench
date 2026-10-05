import { useState } from "react";
import {
  COST_BINNING_LABELS,
  COST_BIN_SIZES,
  COST_MEASURE_LABELS,
  COST_MEASURES,
  costDisplayProblem,
  effectiveCostBinning,
  isCostTotalsChart,
  type CostMeasure,
  COST_CHART_TYPE_LABELS,
  COST_CHART_TYPES,
  COST_DIMENSION_LABELS,
  COST_DIMENSIONS,
  COST_RANGE_PRESET_LABELS,
  COST_RANGE_PRESETS,
  DEFAULT_COST_GRAPH_CONFIG,
  type CostGraphConfig,
} from "@infrawrench/client-core";
import {
  BareInput,
  ChipRow,
  ChipSelect,
  Field,
  FormError,
  Sheet,
  SheetActions,
  TextField,
  ToggleChip,
} from "@/components/form";
import { CostBasisChips } from "./CostBasisChips";
import { CostFilterEditor, useDimensionValues } from "./CostFilterEditor";
import { SavedFilterChip } from "./SavedFilterChip";

/**
 * Author a cost-graph widget: the native counterpart of web's
 * `CostGraphConfigModal`, over the same `CostGraphConfig` and the same
 * defaults, so a graph made on a phone opens unchanged on the web.
 *
 * The one thing web has that a sheet this size can't carry is the custom
 * absolute date range: two date pickers push everything else off the screen,
 * and a widget saved with one keeps it; the presets simply don't offer it, and
 * an absolute range that's already set is shown and left alone.
 */

const CHART_TYPE_OPTIONS = COST_CHART_TYPES.map((t) => ({
  value: t,
  label: COST_CHART_TYPE_LABELS[t],
}));
// Hourly is left out rather than shown as a dead chip: every provider's cost
// rows are daily (the hint below says so), and a chip can't be disabled.
const BINNING_OPTIONS = COST_BIN_SIZES.filter((b) => b !== "hourly").map((b) => ({
  value: b,
  label: COST_BINNING_LABELS[b],
}));
const MEASURE_OPTIONS = COST_MEASURES.map((m) => ({ value: m, label: COST_MEASURE_LABELS[m] }));

/** The legacy `binning: "cumulative"` as a bin size plus the toggle, like web. */
function normalizeDisplayConfig(config: CostGraphConfig): CostGraphConfig {
  if (config.binning !== "cumulative") return config;
  return { ...config, binning: "daily", cumulative: true };
}
const PRESET_OPTIONS = COST_RANGE_PRESETS.map((p) => ({
  value: p,
  label: COST_RANGE_PRESET_LABELS[p],
}));
const GROUP_BY_OPTIONS = [
  { value: "none" as const, label: "None" },
  ...COST_DIMENSIONS.map((d) => ({ value: d, label: COST_DIMENSION_LABELS[d] })),
];

export function CostGraphSheet({
  visible,
  initialTitle,
  initialConfig,
  onSave,
  onClose,
}: {
  visible: boolean;
  initialTitle: string;
  initialConfig: CostGraphConfig;
  onSave: (title: string, config: CostGraphConfig) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [config, setConfig] = useState<CostGraphConfig>(() =>
    normalizeDisplayConfig(initialConfig),
  );
  const measure: CostMeasure = config.measure ?? "cost";
  const { bin, cumulative } = effectiveCostBinning(config);
  // The units the org's cost rows carry, so nobody has to type "GB-Mo".
  const usageUnits = useDimensionValues("usage-units", undefined, measure === "usage");
  const [topNText, setTopNText] = useState(String(initialConfig.topN));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only loaded when grouping by a keyed dimension; the hook stands down
  // otherwise. Provider tags and virtual tags list their keys separately.
  const tagKeys = useDimensionValues("tag-keys", undefined, config.groupBy === "tag");
  const virtualTagKeys = useDimensionValues(
    "virtual-tag-keys",
    undefined,
    config.groupBy === "virtual_tag",
  );

  const set = (patch: Partial<CostGraphConfig>) =>
    setConfig((prev) => ({ ...prev, ...patch }) as CostGraphConfig);

  /** Same clearing rules as web: money-only options go when money does. */
  const setMeasure = (next: CostMeasure) =>
    setConfig((prev) => {
      const updated: CostGraphConfig = { ...prev, measure: next === "cost" ? undefined : next };
      if (next !== "usage") delete updated.usageUnit;
      if (next !== "cost") {
        updated.showForecast = false;
        delete updated.scenarioModelId;
        delete updated.adjusted;
        delete updated.unitCostMetricId;
        delete updated.unitCostMode;
        if (next === "count" && isCostTotalsChart(updated.chartType)) updated.chartType = "line";
      }
      if (next === "count") delete updated.cumulative;
      return updated;
    });

  async function save() {
    const topN = Math.max(1, Math.min(15, Number(topNText) || DEFAULT_COST_GRAPH_CONFIG.topN));
    const cleaned: CostGraphConfig = {
      ...config,
      topN,
      // An empty rule matches everything, which is not what an operator who
      // added a row and picked nothing meant: drop it rather than save it.
      filters: config.filters.filter((f) => f.values.length > 0),
      ...(config.cumulative ? { cumulative: true } : { cumulative: undefined }),
    };
    if (cleaned.groupBy === "tag" && !cleaned.groupByTagKey) {
      setError("Choose a tag key to group by");
      return;
    }
    if (cleaned.groupBy === "virtual_tag" && !cleaned.groupByTagKey) {
      setError("Choose a virtual tag to group by");
      return;
    }
    // The shared rule set the API enforces, checked here so the sheet can say
    // what to fix rather than surfacing a 400.
    const problem = costDisplayProblem({ ...cleaned, forecast: cleaned.showForecast });
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(title.trim(), cleaned);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      visible={visible}
      title="Cost graph"
      onClose={onClose}
      footer={
        <SheetActions
          onCancel={onClose}
          onSubmit={() => void save()}
          submitLabel="Save"
          submitting={saving}
        />
      }
    >
      <TextField
        label="Title"
        value={title}
        onChangeText={setTitle}
        placeholder="e.g. Cloud spend by provider"
        autoCapitalize="sentences"
      />
      <ChipSelect
        label="Chart type"
        options={
          // A count is one series: a pie of it would be a single slice.
          measure === "count"
            ? CHART_TYPE_OPTIONS.filter((o) => !isCostTotalsChart(o.value))
            : CHART_TYPE_OPTIONS
        }
        value={config.chartType}
        onChange={(chartType) => set({ chartType })}
      />
      <ChipSelect
        label="Measure"
        hint={
          measure === "usage"
            ? "Sums the usage quantity providers report, in one unit."
            : measure === "count"
              ? "Distinct values of the group-by with nonzero cost per bin."
              : undefined
        }
        options={MEASURE_OPTIONS}
        value={measure}
        onChange={setMeasure}
      />
      {measure === "usage" ? (
        <ChipSelect
          label="Usage unit"
          hint={
            usageUnits.isLoading
              ? "Loading units…"
              : (usageUnits.data ?? []).length === 0
                ? "No connected provider reports usage quantities yet."
                : "Quantities in different units can't be added."
          }
          options={[
            ...(config.usageUnit &&
            !(usageUnits.data ?? []).some((u) => u.value === config.usageUnit)
              ? [{ value: config.usageUnit, label: config.usageUnit }]
              : []),
            ...(usageUnits.data ?? []).map((u) => ({ value: u.value, label: u.label })),
          ]}
          value={config.usageUnit ?? null}
          onChange={(usageUnit) => set({ usageUnit })}
        />
      ) : null}
      <ChipSelect
        label="Binning"
        hint="Hourly isn't offered: every connected provider reports spend per day."
        options={BINNING_OPTIONS}
        value={bin === "hourly" ? null : bin}
        onChange={(binning) => set({ binning })}
      />
      <ChipSelect
        label="Date range"
        {...(config.dateRange.kind === "absolute"
          ? {
              hint: `Currently ${config.dateRange.from} to ${config.dateRange.to}. Picking a preset replaces it; custom ranges are set on web or desktop.`,
            }
          : {})}
        options={PRESET_OPTIONS}
        value={config.dateRange.kind === "relative" ? config.dateRange.preset : null}
        onChange={(preset) => set({ dateRange: { kind: "relative", preset } })}
      />
      <ChipSelect
        label="Group by"
        options={GROUP_BY_OPTIONS}
        value={config.groupBy}
        onChange={(groupBy) =>
          // The key belongs to the dimension it was picked for: a provider tag
          // key is not a virtual tag key, so any change of grouping drops it.
          set({ groupBy, groupByTagKey: undefined })
        }
      />
      <CostBasisChips value={config.costBasis} onChange={(costBasis) => set({ costBasis })} />
      {config.groupBy === "tag" ? (
        <ChipSelect
          label="Tag key"
          {...(tagKeys.isLoading ? { hint: "Loading tag keys…" } : {})}
          options={(tagKeys.data ?? []).map((k) => ({ value: k.value, label: k.label }))}
          value={config.groupByTagKey ?? null}
          onChange={(groupByTagKey) => set({ groupByTagKey })}
        />
      ) : null}
      {config.groupBy === "virtual_tag" ? (
        <ChipSelect
          label="Virtual tag"
          {...(virtualTagKeys.isLoading
            ? { hint: "Loading virtual tags…" }
            : (virtualTagKeys.data ?? []).length === 0
              ? { hint: "No virtual tags yet. Define one in Settings on web or desktop." }
              : {})}
          options={(virtualTagKeys.data ?? []).map((k) => ({ value: k.value, label: k.label }))}
          value={config.groupByTagKey ?? null}
          onChange={(groupByTagKey) => set({ groupByTagKey })}
        />
      ) : null}
      {/* Read-only on purpose; the reference round-trips through `config`
          untouched, so saving here never detaches it. */}
      <SavedFilterChip savedFilterId={config.savedFilterId} />
      <CostFilterEditor
        filters={config.filters}
        onChange={(filters) => set({ filters })}
        hint={
          config.savedFilterId
            ? "Combined (AND) with the saved filter above."
            : "All spend when empty."
        }
      />
      <Field label="Top groups" hint="1–15; anything beyond folds into “Other”.">
        <ChipRow>
          <BareInput
            accessibilityLabel="Top groups"
            value={topNText}
            onChangeText={setTopNText}
            keyboardType="number-pad"
            width={72}
          />
        </ChipRow>
      </Field>
      <Field label="Extras">
        <ChipRow>
          <ToggleChip
            label="Compare previous period"
            value={config.comparePreviousPeriod}
            onChange={(comparePreviousPeriod) => set({ comparePreviousPeriod })}
          />
          {measure === "cost" ? (
            <ToggleChip
              label="Forecast"
              value={config.showForecast}
              onChange={(showForecast) => set({ showForecast })}
            />
          ) : null}
          {measure !== "count" && !config.unitCostMetricId ? (
            <ToggleChip
              label="Cumulative"
              value={cumulative}
              onChange={(next) => set({ cumulative: next || undefined })}
            />
          ) : null}
        </ChipRow>
      </Field>
      <FormError message={error} />
    </Sheet>
  );
}
