import { useState } from "react";
import { View } from "react-native";
import type { BudgetInput, BudgetThreshold } from "@infrawrench/client-core";
import {
  BareInput,
  Chip,
  ChipRow,
  Field,
  FormError,
  Sheet,
  SheetActions,
  TextField,
} from "@/components/form";
import { Button } from "@/components/ui";
import { CostFilterEditor } from "./CostFilterEditor";

/**
 * Author a budget — the native counterpart of web's `BudgetConfigModal`, over
 * the same `BudgetInput` the API validates.
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
}: {
  visible: boolean;
  initialInput: BudgetInput;
  onSave: (input: BudgetInput) => Promise<void>;
  onClose: () => void;
  title?: string;
}) {
  const [input, setInput] = useState<BudgetInput>(initialInput);
  const [amountText, setAmountText] = useState((initialInput.amountCents / 100).toString());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<BudgetInput>) =>
    setInput((prev) => ({ ...prev, ...patch }) as BudgetInput);

  const setThreshold = (index: number, patch: Partial<BudgetThreshold>) =>
    set({ thresholds: input.thresholds.map((t, i) => (i === index ? { ...t, ...patch } : t)) });

  async function save() {
    const amount = Number(amountText);
    if (!input.name.trim()) {
      setError("Give the budget a name");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a budget amount greater than zero");
      return;
    }
    if (input.currency.trim().length !== 3) {
      setError("Currency is a three-letter code");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...input,
        name: input.name.trim(),
        amountCents: Math.round(amount * 100),
        currency: input.currency.trim().toUpperCase(),
        filters: input.filters.filter((f) => f.values.length > 0),
      });
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
      title={title}
      description="Monthly spend threshold over a cost scope. Alerts fire once per month per threshold."
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
      <Field label="Monthly amount">
        <ChipRow>
          <BareInput
            accessibilityLabel="Monthly amount"
            value={amountText}
            onChangeText={setAmountText}
            keyboardType="decimal-pad"
            width={120}
          />
          <BareInput
            accessibilityLabel="Currency"
            value={input.currency}
            onChangeText={(currency) => set({ currency: currency.toUpperCase() })}
            width={80}
          />
        </ChipRow>
      </Field>
      <CostFilterEditor
        label="Scope"
        hint="All spend when empty."
        filters={input.filters}
        onChange={(filters) => set({ filters })}
      />
      <Field label="Alert thresholds">
        {input.thresholds.map((threshold, i) => (
          <View key={i} style={{ gap: 6, marginBottom: 8 }}>
            <ChipRow>
              <Chip
                label="Actual spend"
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
      <FormError message={error} />
    </Sheet>
  );
}
