import { useState } from "react";
import { View } from "react-native";
import {
  BUDGET_LIMITS,
  BUDGET_PERIOD_UNITS,
  BUDGET_PERIOD_UNIT_LABELS,
  budgetDepth,
  budgetDescendantIds,
  budgetInputError,
  budgetSubtreeHeight,
  formatBudgetPeriodWindow,
  type BudgetInput,
  type BudgetPeriodUnit,
  type BudgetThreshold,
  type BudgetWithStatus,
} from "@infrawrench/client-core";
import {
  BareInput,
  Chip,
  ChipRow,
  ChipSelect,
  Field,
  FormError,
  FormHint,
  Sheet,
  SheetActions,
  TextField,
} from "@/components/form";
import { Button } from "@/components/ui";
import { CostBasisChips } from "./CostBasisChips";
import { CostFilterEditor, useDimensionValues } from "./CostFilterEditor";
import { ScenarioChip } from "./ScenarioChip";
import { SavedFilterChip } from "./SavedFilterChip";
import { EmailRecipientsField } from "./EmailRecipientsField";

type PeriodMode = "monthly" | "recurring" | "explicit";

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Author a budget: the native counterpart of web's `BudgetConfigModal`, over
 * the same `BudgetInput` the API validates, including what it counts (spend or
 * a usage quantity), its period (calendar month or a custom cadence) and its
 * parent.
 *
 * One deliberate gap against web and desktop: an **explicit period list** is
 * shown and preserved but not edited here. It is a table of date pairs with an
 * amount each, and two date pickers per row do not fit a sheet (the same line
 * the graph editor draws at custom absolute date ranges).
 *
 * A budget outlives the card that shows it: creating one from a dashboard also
 * starts it evaluating and alerting, which is why this is a real editor rather
 * than a pointer at the web app. Editing an existing budget from its card edits
 * the budget itself, so the change follows it to every dashboard it sits on.
 */
export function BudgetSheet({
  visible,
  initialInput,
  onSave,
  onClose,
  title = "Budget",
  budgets = [],
  budgetId = null,
}: {
  visible: boolean;
  initialInput: BudgetInput;
  onSave: (input: BudgetInput) => Promise<void>;
  onClose: () => void;
  title?: string;
  /** Every budget in the org, for the parent picker. */
  budgets?: BudgetWithStatus[];
  /** The budget being edited, kept (with its descendants) out of the parent picker. */
  budgetId?: string | null;
}) {
  const [input, setInput] = useState<BudgetInput>(initialInput);
  const [amountText, setAmountText] = useState(
    initialInput.amountCents > 0 ? (initialInput.amountCents / 100).toString() : "",
  );
  const [usageText, setUsageText] = useState(
    initialInput.usageAmount !== undefined ? String(initialInput.usageAmount) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usage = input.measure === "usage";
  const periodMode: PeriodMode = input.period?.kind ?? "monthly";
  const units = useDimensionValues("usage-units", undefined, usage);

  const set = (patch: Partial<BudgetInput>) =>
    setInput((prev) => ({ ...prev, ...patch }) as BudgetInput);

  const setThreshold = (index: number, patch: Partial<BudgetThreshold>) =>
    set({ thresholds: input.thresholds.map((t, i) => (i === index ? { ...t, ...patch } : t)) });

  async function save() {
    if (!input.name.trim()) {
      setError("Give the budget a name");
      return;
    }
    const explicit = periodMode === "explicit";
    let amountCents = 0;
    if (!usage && !explicit) {
      const amount = Number(amountText);
      if (!Number.isFinite(amount) || amount <= 0) {
        setError("Enter a budget amount greater than zero");
        return;
      }
      amountCents = Math.round(amount * 100);
    }
    let usageAmount: number | undefined;
    if (usage && !explicit) {
      const amount = Number(usageText);
      if (!Number.isFinite(amount) || amount <= 0) {
        setError("Enter a usage amount greater than zero");
        return;
      }
      usageAmount = amount;
    }
    if (!usage && input.currency.trim().length !== 3) {
      setError("Currency is a three-letter code");
      return;
    }
    const next: BudgetInput = {
      ...input,
      name: input.name.trim(),
      amountCents,
      currency: input.currency.trim().toUpperCase(),
      filters: input.filters.filter((f) => f.values.length > 0),
    };
    // Fields of the other measure are dropped, so switching never saves a
    // combination the API refuses.
    if (usage) {
      delete next.scenarioModelId;
      delete next.useAdjustedSpend;
      if (usageAmount !== undefined) next.usageAmount = usageAmount;
      else delete next.usageAmount;
    } else {
      delete next.usageUnit;
      delete next.usageAmount;
    }
    const combinationError = budgetInputError(next);
    if (combinationError) {
      setError(combinationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // Parent candidates: same measure and unit, not this budget or below it,
  // and shallow enough to stay inside the depth limit. The API checks again.
  const excluded = budgetId ? budgetDescendantIds(budgets, budgetId) : new Set<string>();
  const ownHeight = budgetId ? budgetSubtreeHeight(budgets, budgetId) : 1;
  const parents = budgets.filter(
    (b) =>
      b.id !== budgetId &&
      !excluded.has(b.id) &&
      (b.measure === "usage") === usage &&
      (usage ? b.usageUnit === input.usageUnit : b.currency === input.currency) &&
      budgetDepth(budgets, b.id) + ownHeight <= BUDGET_LIMITS.maxDepth,
  );
  const unitOptions = (units.data ?? []).map((v) =>
    typeof v === "string" ? v : (v as { value: string }).value,
  );
  if (input.usageUnit && !unitOptions.includes(input.usageUnit)) {
    unitOptions.unshift(input.usageUnit);
  }

  return (
    <Sheet
      visible={visible}
      title={title}
      description="A spend or usage limit over a cost scope, per period. Alerts fire once per period per threshold."
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
        label="Name"
        value={input.name}
        onChangeText={(name) => set({ name })}
        placeholder="e.g. Production AWS"
        autoCapitalize="sentences"
      />
      <ChipSelect
        label="Measure"
        options={[
          { value: "cost", label: "Spend" },
          { value: "usage", label: "Usage quantity" },
        ]}
        value={usage ? "usage" : "cost"}
        onChange={(measure) =>
          set(measure === "usage" ? { measure: "usage" } : { measure: undefined })
        }
      />
      {usage ? (
        <>
          <Field
            label="Usage unit"
            hint={
              units.isLoading
                ? "Loading units…"
                : unitOptions.length === 0
                  ? "No provider has reported usage quantities yet."
                  : undefined
            }
          >
            <ChipRow>
              {unitOptions.map((unit) => (
                <Chip
                  key={unit}
                  label={unit}
                  selected={input.usageUnit === unit}
                  onPress={() => set({ usageUnit: unit })}
                />
              ))}
            </ChipRow>
          </Field>
          {periodMode !== "explicit" ? (
            <Field label="Amount per period">
              <BareInput
                accessibilityLabel="Usage amount per period"
                value={usageText}
                onChangeText={setUsageText}
                keyboardType="decimal-pad"
                width={160}
              />
            </Field>
          ) : null}
        </>
      ) : (
        <Field label={periodMode === "monthly" ? "Monthly amount" : "Amount per period"}>
          <ChipRow>
            {periodMode !== "explicit" ? (
              <BareInput
                accessibilityLabel="Amount"
                value={amountText}
                onChangeText={setAmountText}
                keyboardType="decimal-pad"
                width={120}
              />
            ) : null}
            <BareInput
              accessibilityLabel="Currency"
              value={input.currency}
              onChangeText={(currency) => set({ currency: currency.toUpperCase() })}
              width={80}
            />
          </ChipRow>
        </Field>
      )}

      <Field label="Period">
        <ChipRow>
          <Chip
            label="Calendar month"
            selected={periodMode === "monthly"}
            onPress={() => set({ period: undefined })}
          />
          <Chip
            label="Custom cadence"
            selected={periodMode === "recurring"}
            onPress={() =>
              periodMode === "recurring"
                ? undefined
                : set({
                    period: { kind: "recurring", unit: "week", interval: 1, startDate: todayIso() },
                  })
            }
          />
        </ChipRow>
        {input.period?.kind === "recurring" ? (
          <View style={{ gap: 8, marginTop: 8 }}>
            <ChipRow>
              <BareInput
                accessibilityLabel="Interval count"
                value={String(input.period.interval)}
                onChangeText={(text) =>
                  input.period?.kind === "recurring" &&
                  set({
                    period: {
                      ...input.period,
                      interval: Math.max(
                        1,
                        Math.min(BUDGET_LIMITS.maxInterval, Math.round(Number(text) || 1)),
                      ),
                    },
                  })
                }
                keyboardType="number-pad"
                width={72}
              />
              {BUDGET_PERIOD_UNITS.map((unit: BudgetPeriodUnit) => (
                <Chip
                  key={unit}
                  label={BUDGET_PERIOD_UNIT_LABELS[unit]}
                  selected={input.period?.kind === "recurring" && input.period.unit === unit}
                  onPress={() =>
                    input.period?.kind === "recurring" && set({ period: { ...input.period, unit } })
                  }
                />
              ))}
            </ChipRow>
            <BareInput
              accessibilityLabel="Start date"
              placeholder="YYYY-MM-DD"
              value={input.period.startDate}
              onChangeText={(startDate) =>
                input.period?.kind === "recurring" &&
                set({ period: { ...input.period, startDate: startDate.trim() } })
              }
            />
          </View>
        ) : null}
        {input.period?.kind === "explicit" ? (
          <FormHint>
            {`${input.period.periods.length} explicit periods (${input.period.periods
              .slice(0, 2)
              .map((p) => formatBudgetPeriodWindow(p))
              .join(
                ", ",
              )}${input.period.periods.length > 2 ? ", …" : ""}). Edit the list from web or desktop; saving here keeps it.`}
          </FormHint>
        ) : null}
      </Field>

      {budgets.length > 0 ? (
        <Field
          label="Parent budget"
          hint="A parent's actual and forecast are the sum of its children's."
        >
          <ChipRow>
            <Chip
              label="None"
              selected={!input.parentBudgetId}
              onPress={() => set({ parentBudgetId: undefined })}
            />
            {parents.map((b) => (
              <Chip
                key={b.id}
                label={b.name}
                selected={input.parentBudgetId === b.id}
                onPress={() => set({ parentBudgetId: b.id })}
              />
            ))}
          </ChipRow>
        </Field>
      ) : null}

      {!usage ? (
        <CostBasisChips value={input.costBasis} onChange={(costBasis) => set({ costBasis })} />
      ) : null}
      {/* Read-only on purpose; the reference round-trips through `input`
          untouched, so saving here never widens the budget. */}
      <SavedFilterChip savedFilterId={input.savedFilterId} />

      {!usage ? <ScenarioChip scenarioModelId={input.scenarioModelId} /> : null}
      <CostFilterEditor
        label="Scope"
        hint={
          input.savedFilterId
            ? "Combined (AND) with the saved filter above."
            : "All spend when empty."
        }
        filters={input.filters}
        onChange={(filters) => set({ filters })}
      />
      <Field label="Alert thresholds">
        {input.thresholds.map((threshold, i) => (
          <View key={i} style={{ gap: 6, marginBottom: 8 }}>
            <ChipRow>
              <Chip
                label={usage ? "Actual usage" : "Actual spend"}
                selected={threshold.type === "actual"}
                onPress={() => setThreshold(i, { type: "actual" })}
              />
              <Chip
                label="Forecast"
                selected={threshold.type === "forecast"}
                onPress={() => setThreshold(i, { type: "forecast" })}
              />
              <BareInput
                accessibilityLabel="Threshold percent"
                value={String(threshold.percent)}
                onChangeText={(text) =>
                  setThreshold(i, { percent: Math.max(1, Math.min(1000, Number(text) || 1)) })
                }
                keyboardType="number-pad"
                width={72}
              />
            </ChipRow>
            {input.thresholds.length > 1 ? (
              <Button
                label="Remove threshold"
                variant="secondary"
                onPress={() => set({ thresholds: input.thresholds.filter((_, j) => j !== i) })}
              />
            ) : null}
          </View>
        ))}
        {input.thresholds.length < 10 ? (
          <Button
            label="Add threshold"
            variant="secondary"
            onPress={() =>
              set({ thresholds: [...input.thresholds, { type: "actual", percent: 90 }] })
            }
          />
        ) : null}
      </Field>
      <EmailRecipientsField
        value={input.emailRecipients ?? { userIds: [], addresses: [] }}
        onChange={(emailRecipients) => set({ emailRecipients })}
      />
      <FormError message={error} />
    </Sheet>
  );
}
