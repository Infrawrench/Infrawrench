import { useEffect, useId, useState } from "react";
import {
  budgetInputSchema,
  type BudgetInput,
  type CostFilter,
  type CostScenarioModel,
} from "./config.js";
import {
  COST_BASIS_UNAVAILABLE_HINT,
  CostBasisField,
  CostFilterEditor,
  useCostBasisChoice,
} from "./CostGraphConfigModal.js";
import { Modal } from "../components/Modal.js";
import type { CostApi } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

// Shared with mobile, which authors the same budgets without this package.
export { DEFAULT_BUDGET_INPUT } from "./config.js";

export interface BudgetConfigModalProps {
  initialInput: BudgetInput;
  api: CostApi;
  onSave: (input: BudgetInput) => Promise<void> | void;
  onClose: () => void;
}

export function BudgetConfigModal({ initialInput, api, onSave, onClose }: BudgetConfigModalProps) {
  const uid = useId();
  const [input, setInput] = useState<BudgetInput>(initialInput);
  const [amountText, setAmountText] = useState(() => (initialInput.amountCents / 100).toString());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * A scope query the text editor could not compile. Saving is blocked while
   * set, for the same reason the graph modal blocks: the input still holds the
   * last filter that parsed, and saving now would scope the budget differently
   * from what is on screen — for a budget, an alert-firing difference.
   */
  const [filterError, setFilterError] = useState<string | null>(null);
  const basis = useCostBasisChoice(api, initialInput.costBasis === "amortized");

  const set = (patch: Partial<BudgetInput>) =>
    setInput((prev) => ({ ...prev, ...patch }) as BudgetInput);

  const save = async () => {
    if (filterError) {
      setError("Fix the scope query before saving.");
      return;
    }
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
    <Modal onClose={onClose} ariaLabel="Budget">
      <div className="w-[32rem] max-w-[90vw] rounded-2xl border border-border bg-surface-raised p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-on-surface mb-1">Budget</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          Monthly spend threshold over a cost scope. Alerts fire once per month per threshold.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor={`${uid}-name`} className={labelClass}>
              Name
            </label>
            <input
              id={`${uid}-name`}
              className={inputClass}
              placeholder="e.g. Production AWS"
              value={input.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${uid}-amount`} className={labelClass}>
                Monthly amount
              </label>
              <input
                id={`${uid}-amount`}
                type="number"
                min={0}
                step="0.01"
                className={inputClass}
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-currency`} className={labelClass}>
                Currency
              </label>
              <input
                id={`${uid}-currency`}
                className={inputClass}
                maxLength={3}
                value={input.currency}
                onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
              />
            </div>
          </div>

          <CostBasisField
            id={`${uid}-cost-basis`}
            value={input.costBasis}
            onChange={(costBasis) => set({ costBasis })}
            available={basis.available}
            hint={COST_BASIS_UNAVAILABLE_HINT}
          />

          <div role="group" aria-labelledby={`${uid}-scope-label`}>
            <span id={`${uid}-scope-label`} className={labelClass}>
              Scope (all spend when empty)
            </span>
            <CostFilterEditor
              filters={input.filters as CostFilter[]}
              onChange={(filters) => set({ filters })}
              api={api}
              onErrorChange={setFilterError}
              savedFilterId={input.savedFilterId}
              onSavedFilterChange={(savedFilterId) => set({ savedFilterId })}
            />
          </div>

          <BudgetScenarioField
            id={`${uid}-scenario`}
            api={api}
            value={input.scenarioModelId ?? null}
            hasForecastThreshold={input.thresholds.some((t) => t.type === "forecast")}
            onChange={(scenarioModelId) =>
              set(scenarioModelId ? { scenarioModelId } : { scenarioModelId: undefined })
            }
          />

          <div role="group" aria-labelledby={`${uid}-thresholds-label`}>
            <span id={`${uid}-thresholds-label`} className={labelClass}>
              Alert thresholds
            </span>
            <div className="space-y-2">
              {input.thresholds.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    aria-label="Threshold type"
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
                    aria-label="Threshold percent"
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
                  className="text-xs text-info hover:text-info-strong"
                >
                  + Add threshold
                </button>
              )}
            </div>
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
              disabled={saving || filterError !== null}
              className="px-3 py-1.5 rounded-lg text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition-colors"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Opt this budget's **forecast** thresholds into a scenario model.
 *
 * The control exists at all because the opt-in has to be visible on the object
 * it changes. A scenario is somebody's hypothesis; a forecast threshold decides
 * when a person is paged. Making that connection a per-budget checkbox — rather
 * than something a scenario does to every budget in the org — is the whole
 * decision, and it is worth stating in the form rather than only in the docs.
 *
 * Rendered only when the host wired `listScenarioModels` and the org has at
 * least one model: an empty picker reads as "broken" rather than "none yet".
 */
function BudgetScenarioField({
  id,
  api,
  value,
  hasForecastThreshold,
  onChange,
}: {
  id: string;
  api: CostApi;
  value: string | null;
  hasForecastThreshold: boolean;
  onChange: (scenarioModelId: string | null) => void;
}) {
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

  if (!load || !models || models.length === 0) return null;
  const selected = models.find((m) => m.id === value) ?? null;

  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        Scenario (forecast thresholds only)
      </label>
      <select
        id={id}
        className={inputClass}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">None — measure the bare trend</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11px] text-on-surface-faint">
        {selected ? (
          <>
            Forecast thresholds are judged against the trend <strong>plus</strong> “{selected.name}
            ”, and alerts say so. Actual-spend thresholds are unaffected — they measure money
            already spent.
            {!hasForecastThreshold &&
              " This budget has no forecast threshold, so nothing uses it yet."}
          </>
        ) : (
          "Forecast thresholds measure the unadjusted trend. Pick a model to have this budget — and only this budget — alert on assumptions you have written down."
        )}
      </p>
    </div>
  );
}
