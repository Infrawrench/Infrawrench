import { useState } from "react";
import { budgetInputSchema, type BudgetInput, type CostFilter } from "./config.js";
import { CostFilterRows } from "./CostGraphConfigModal.js";
import type { CostApi } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

export const DEFAULT_BUDGET_INPUT: BudgetInput = {
  name: "",
  amountCents: 100000,
  currency: "USD",
  filters: [],
  thresholds: [
    { type: "actual", percent: 80 },
    { type: "actual", percent: 100 },
  ],
};

export interface BudgetConfigModalProps {
  initialInput: BudgetInput;
  api: CostApi;
  onSave: (input: BudgetInput) => Promise<void> | void;
  onClose: () => void;
}

export function BudgetConfigModal({ initialInput, api, onSave, onClose }: BudgetConfigModalProps) {
  const [input, setInput] = useState<BudgetInput>(initialInput);
  const [amountText, setAmountText] = useState((initialInput.amountCents / 100).toString());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<BudgetInput>) =>
    setInput((prev) => ({ ...prev, ...patch }) as BudgetInput);

  const save = async () => {
    const amount = Number(amountText);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter a budget amount greater than zero");
      return;
    }
    const cleaned = {
      ...input,
      amountCents: Math.round(amount * 100),
      filters: input.filters.filter((f) => f.values.length > 0),
    };
    const parsed = budgetInputSchema.safeParse(cleaned);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid budget");
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
        <h2 className="text-lg font-semibold text-on-surface mb-1">Budget</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          Monthly spend threshold over a cost scope. Alerts fire once per month per threshold.
        </p>

        <div className="space-y-4">
          <div>
            <label className={labelClass}>Name</label>
            <input
              className={inputClass}
              placeholder="e.g. Production AWS"
              value={input.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Monthly amount</label>
              <input
                type="number"
                min={0}
                step="0.01"
                className={inputClass}
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
              />
            </div>
            <div>
              <label className={labelClass}>Currency</label>
              <input
                className={inputClass}
                maxLength={3}
                value={input.currency}
                onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
              />
            </div>
          </div>

          <div>
            <label className={labelClass}>Scope (all spend when empty)</label>
            <CostFilterRows
              filters={input.filters as CostFilter[]}
              onChange={(filters) => set({ filters })}
              api={api}
            />
          </div>

          <div>
            <label className={labelClass}>Alert thresholds</label>
            <div className="space-y-2">
              {input.thresholds.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    className={`${inputClass} w-32`}
                    value={t.type}
                    onChange={(e) =>
                      set({
                        thresholds: input.thresholds.map((x, j) =>
                          j === i ? { ...x, type: e.target.value as "actual" | "forecast" } : x,
                        ),
                      })
                    }
                  >
                    <option value="actual">Actual spend</option>
                    <option value="forecast">Forecast</option>
                  </select>
                  <span className="text-xs text-on-surface-secondary">reaches</span>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    className={`${inputClass} w-20`}
                    value={t.percent}
                    onChange={(e) =>
                      set({
                        thresholds: input.thresholds.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                percent: Math.max(1, Math.min(1000, Number(e.target.value) || 1)),
                              }
                            : x,
                        ),
                      })
                    }
                  />
                  <span className="text-xs text-on-surface-secondary">%</span>
                  {input.thresholds.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        set({ thresholds: input.thresholds.filter((_, j) => j !== i) })
                      }
                      className="text-on-surface-faint hover:text-on-surface-secondary text-xs"
                      title="Remove threshold"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {input.thresholds.length < 10 && (
                <button
                  type="button"
                  onClick={() =>
                    set({ thresholds: [...input.thresholds, { type: "actual", percent: 90 }] })
                  }
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  + Add threshold
                </button>
              )}
            </div>
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
