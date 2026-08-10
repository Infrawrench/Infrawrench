import { useState } from "react";
import {
  COST_BINNING_LABELS,
  COST_BINNINGS,
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
 * Author a cost-graph widget — the native counterpart of web's
 * `CostGraphConfigModal`, over the same `CostGraphConfig` and the same
 * defaults, so a graph made on a phone opens unchanged on the web.
 *
 * The one thing web has that a sheet this size can't carry is the custom
 * absolute date range: two date pickers push everything else off the screen,
 * and a widget saved with one keeps it — the presets simply don't offer it, and
 * an absolute range that's already set is shown and left alone.
 */

const CHART_TYPE_OPTIONS = COST_CHART_TYPES.map((t) => ({
  value: t,
  label: COST_CHART_TYPE_LABELS[t],
}));
const BINNING_OPTIONS = COST_BINNINGS.map((b) => ({ value: b, label: COST_BINNING_LABELS[b] }));
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
  const [config, setConfig] = useState<CostGraphConfig>(initialConfig);
  const [topNText, setTopNText] = useState(String(initialConfig.topN));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only loaded when grouping by tag; the hook stands down otherwise.
  const tagKeys = useDimensionValues("tag-keys", undefined, config.groupBy === "tag");

  const set = (patch: Partial<CostGraphConfig>) =>
    setConfig((prev) => ({ ...prev, ...patch }) as CostGraphConfig);

  async function save() {
    const topN = Math.max(1, Math.min(15, Number(topNText) || DEFAULT_COST_GRAPH_CONFIG.topN));
    const cleaned: CostGraphConfig = {
      ...config,
      topN,
      // An empty rule matches everything, which is not what an operator who
      // added a row and picked nothing meant — drop it rather than save it.
      filters: config.filters.filter((f) => f.values.length > 0),
    };
    if (cleaned.groupBy === "tag" && !cleaned.groupByTagKey) {
      setError("Choose a tag key to group by");
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
        options={CHART_TYPE_OPTIONS}
        value={config.chartType}
        onChange={(chartType) => set({ chartType })}
      />
      <ChipSelect
        label="Binning"
        options={BINNING_OPTIONS}
        value={config.binning}
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
          set({ groupBy, ...(groupBy === "tag" ? {} : { groupByTagKey: undefined }) })
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
          <ToggleChip
            label="Forecast"
            value={config.showForecast}
            onChange={(showForecast) => set({ showForecast })}
          />
        </ChipRow>
      </Field>
      <FormError message={error} />
    </Sheet>
  );
}
