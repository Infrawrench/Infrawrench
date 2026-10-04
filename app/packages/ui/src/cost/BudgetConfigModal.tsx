import { useEffect, useId, useState } from "react";
import { T, Var, useGT, useMessages } from "gt-react";
import {
  BUDGET_LIMITS,
  BUDGET_PERIOD_UNITS,
  budgetDepth,
  budgetDescendantIds,
  budgetInputError,
  budgetInputSchema,
  budgetSubtreeHeight,
  type BudgetExplicitPeriod,
  type BudgetInput,
  type BudgetPeriod,
  type BudgetPeriodUnit,
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
import type { AlertEmailRecipients } from "@infrawrench/client-core";
import { LoadedAlertEmailRecipientsField } from "./AlertEmailRecipientsField.js";
import type { BudgetWithStatus, CostApi } from "./types.js";
import { CloseIcon } from "../components/icons/ChromeIcons.js";

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
  /**
   * The org's budgets, for the parent picker. Omitted by a host that has not
   * loaded them; the picker is then left out and an existing parent still
   * round-trips untouched through `initialInput`.
   */
  budgets?: BudgetWithStatus[] | undefined;
  /** The budget being edited (null for a new one), to keep it and its descendants out of the parent picker. */
  budgetId?: string | null | undefined;
}

type PeriodMode = "monthly" | "recurring" | "explicit";

const todayIso = () => new Date().toISOString().slice(0, 10);

export function BudgetConfigModal({
  initialInput,
  api,
  onSave,
  onClose,
  budgets,
  budgetId,
}: BudgetConfigModalProps) {
  const gt = useGT();
  const m = useMessages();
  const uid = useId();
  const [input, setInput] = useState<BudgetInput>(initialInput);
  const [amountText, setAmountText] = useState(() =>
    initialInput.amountCents > 0 ? (initialInput.amountCents / 100).toString() : "",
  );
  const [usageText, setUsageText] = useState(() =>
    initialInput.usageAmount !== undefined ? String(initialInput.usageAmount) : "",
  );
  const usage = input.measure === "usage";
  const periodMode: PeriodMode = input.period?.kind ?? "monthly";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * A scope query the text editor could not compile. Saving is blocked while
   * set, for the same reason the graph modal blocks: the input still holds the
   * last filter that parsed, and saving now would scope the budget differently
   * from what is on screen, for a budget, an alert-firing difference.
   */
  const [filterError, setFilterError] = useState<string | null>(null);
  const basis = useCostBasisChoice(api, initialInput.costBasis);

  const set = (patch: Partial<BudgetInput>) =>
    setInput((prev) => ({ ...prev, ...patch }) as BudgetInput);

  const save = async () => {
    if (filterError) {
      setError(gt("Fix the scope query before saving."));
      return;
    }
    const explicit = periodMode === "explicit";
    // The top-level amount is the limit only for a spend budget without an
    // explicit period list; anywhere else it is unused, and stored as 0.
    let amountCents = 0;
    if (!usage && !explicit) {
      const amount = Number(amountText);
      if (!Number.isFinite(amount) || amount <= 0) {
        setError(gt("Enter a budget amount greater than zero"));
        return;
      }
      amountCents = Math.round(amount * 100);
    }
    let usageAmount: number | undefined;
    if (usage && !explicit) {
      const amount = Number(usageText);
      if (!Number.isFinite(amount) || amount <= 0) {
        setError(gt("Enter a usage amount greater than zero"));
        return;
      }
      usageAmount = amount;
    }
    const { usageUnit, scenarioModelId, useAdjustedSpend } = input;
    const rest: BudgetInput = { ...input };
    delete rest.usageUnit;
    delete rest.usageAmount;
    delete rest.scenarioModelId;
    delete rest.useAdjustedSpend;
    // Explicit periods carry their amounts in whichever field the measure uses.
    if (rest.period?.kind === "explicit") {
      rest.period = {
        kind: "explicit",
        periods: rest.period.periods.map((p) => {
          const amount = usage
            ? p.usageAmount
            : p.amountCents !== undefined
              ? p.amountCents / 100
              : undefined;
          return withPeriodAmount(p, usage, amount);
        }),
      };
    }
    const cleaned: BudgetInput = {
      ...rest,
      amountCents,
      filters: input.filters.filter((f) => f.values.length > 0),
      // Usage-only and spend-only fields are dropped on the other measure, so
      // switching a budget's measure never saves a combination the API refuses.
      ...(usage
        ? {
            ...(usageUnit ? { usageUnit } : {}),
            ...(usageAmount !== undefined ? { usageAmount } : {}),
          }
        : {
            ...(scenarioModelId ? { scenarioModelId } : {}),
            ...(useAdjustedSpend ? { useAdjustedSpend } : {}),
          }),
    };
    const parsed = budgetInputSchema.safeParse(cleaned);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? gt("Invalid budget"));
      return;
    }
    // The cross-field rules the API also runs: same sentence, before the trip.
    const combinationError = budgetInputError(parsed.data);
    if (combinationError) {
      setError(combinationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed.data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} ariaLabel={gt("Budget")}>
      <div className="w-[32rem] max-w-[90vw] rounded-2xl border border-border bg-surface-raised p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-on-surface mb-1">{gt("Budget")}</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {gt(
            "A spend or usage limit over a cost scope, per period. Alerts fire once per period per threshold.",
          )}
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor={`${uid}-name`} className={labelClass}>
              {gt("Name")}
            </label>
            <input
              id={`${uid}-name`}
              className={inputClass}
              placeholder={gt("e.g. Production AWS")}
              value={input.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>

          <div role="radiogroup" aria-labelledby={`${uid}-measure-label`}>
            <span id={`${uid}-measure-label`} className={labelClass}>
              {gt("Measure")}
            </span>
            <div className="flex gap-2">
              {(["cost", "usage"] as const).map((measure) => (
                <button
                  key={measure}
                  type="button"
                  role="radio"
                  aria-checked={(input.measure ?? "cost") === measure}
                  onClick={() =>
                    set(measure === "usage" ? { measure: "usage" } : { measure: undefined })
                  }
                  className={`px-3 py-1 rounded-lg text-xs border transition-colors ${
                    (input.measure ?? "cost") === measure
                      ? "border-blue-500 bg-blue-500/10 text-on-surface"
                      : "border-border text-on-surface-secondary hover:bg-surface-sunken"
                  }`}
                >
                  {measure === "cost" ? gt("Spend") : gt("Usage quantity")}
                </button>
              ))}
            </div>
          </div>

          {usage ? (
            <div className="grid grid-cols-2 gap-3">
              <UsageUnitField
                id={`${uid}-usage-unit`}
                api={api}
                value={input.usageUnit ?? ""}
                onChange={(usageUnit) => set(usageUnit ? { usageUnit } : { usageUnit: undefined })}
              />
              {periodMode !== "explicit" && (
                <div>
                  <label htmlFor={`${uid}-usage-amount`} className={labelClass}>
                    {gt("Amount per period")}
                  </label>
                  <input
                    id={`${uid}-usage-amount`}
                    type="number"
                    min={0}
                    step="any"
                    className={inputClass}
                    value={usageText}
                    onChange={(e) => setUsageText(e.target.value)}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {periodMode !== "explicit" && (
                <div>
                  <label htmlFor={`${uid}-amount`} className={labelClass}>
                    {periodMode === "monthly" ? gt("Monthly amount") : gt("Amount per period")}
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
              )}
              <div>
                <label htmlFor={`${uid}-currency`} className={labelClass}>
                  {gt("Currency")}
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
          )}

          <BudgetPeriodField
            id={`${uid}-period`}
            usage={usage}
            value={input.period}
            onChange={(period) => set(period ? { period } : { period: undefined })}
          />

          {budgets && (
            <BudgetParentField
              id={`${uid}-parent`}
              budgets={budgets}
              budgetId={budgetId ?? null}
              input={input}
              onChange={(parentBudgetId) =>
                set(parentBudgetId ? { parentBudgetId } : { parentBudgetId: undefined })
              }
            />
          )}

          {!usage && (
            <CostBasisField
              id={`${uid}-cost-basis`}
              value={input.costBasis}
              onChange={(costBasis) => set({ costBasis })}
              available={basis.available}
              blendingAvailable={basis.blendingAvailable}
              hint={m(COST_BASIS_UNAVAILABLE_HINT)}
            />
          )}

          <div role="group" aria-labelledby={`${uid}-scope-label`}>
            <span id={`${uid}-scope-label`} className={labelClass}>
              {gt("Scope (all spend when empty)")}
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

          {!usage && (
            <BudgetScenarioField
              id={`${uid}-scenario`}
              api={api}
              value={input.scenarioModelId ?? null}
              hasForecastThreshold={input.thresholds.some((t) => t.type === "forecast")}
              onChange={(scenarioModelId) =>
                set(scenarioModelId ? { scenarioModelId } : { scenarioModelId: undefined })
              }
            />
          )}

          <div role="group" aria-labelledby={`${uid}-thresholds-label`}>
            <span id={`${uid}-thresholds-label`} className={labelClass}>
              {gt("Alert thresholds")}
            </span>
            <div className="space-y-2">
              {input.thresholds.map((t, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    aria-label={gt("Threshold type")}
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
                    <option value="actual">
                      {usage ? gt("Actual usage") : gt("Actual spend")}
                    </option>
                    <option value="forecast">{gt("Forecast")}</option>
                  </select>
                  <span className="text-xs text-on-surface-secondary">{gt("reaches")}</span>
                  <input
                    aria-label={gt("Threshold percent")}
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
                      title={gt("Remove threshold")}
                    >
                      <CloseIcon size={12} />
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
                  {gt("+ Add threshold")}
                </button>
              )}
            </div>
          </div>

          {api.getAlertEmailOptions && (
            <BudgetEmailField
              api={api}
              value={input.emailRecipients ?? { userIds: [], addresses: [] }}
              onChange={(emailRecipients) => set({ emailRecipients })}
            />
          )}

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
 * Opt this budget's **forecast** thresholds into a scenario model.
 *
 * The control exists at all because the opt-in has to be visible on the object
 * it changes. A scenario is somebody's hypothesis; a forecast threshold decides
 * when a person is paged. Making that connection a per-budget checkbox (rather
 * than something a scenario does to every budget in the org) is the whole
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
  const gt = useGT();
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
        {gt("Scenario (forecast thresholds only)")}
      </label>
      <select
        id={id}
        className={inputClass}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{gt("None — measure the bare trend")}</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11px] text-on-surface-faint">
        {selected ? (
          <>
            <T>
              <>
                Forecast thresholds are judged against the trend <strong>plus</strong> “
                <Var>{selected.name}</Var>”, and alerts say so. Actual-spend thresholds are
                unaffected — they measure money already spent.
              </>
            </T>
            {!hasForecastThreshold && (
              <> {gt("This budget has no forecast threshold, so nothing uses it yet.")}</>
            )}
          </>
        ) : (
          gt(
            "Forecast thresholds measure the unadjusted trend. Pick a model to have this budget — and only this budget — alert on assumptions you have written down.",
          )
        )}
      </p>
    </div>
  );
}

/**
 * The usage unit a usage budget counts. A picker over the units the org's cost
 * rows actually carry (`dimension=usage-units`), because a unit typed from
 * memory that matches no row would make a budget that measures nothing. A
 * unit saved earlier that no longer appears is kept as an option rather than
 * silently replaced.
 */
function UsageUnitField({
  id,
  api,
  value,
  onChange,
}: {
  id: string;
  api: CostApi;
  value: string;
  onChange: (unit: string) => void;
}) {
  const gt = useGT();
  const [units, setUnits] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .loadDimensionValues("usage-units")
      .then((options) => {
        if (!cancelled) setUnits(options.map((o) => o.value));
      })
      .catch(() => {
        if (!cancelled) setUnits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const options = units ?? [];
  const all = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {gt("Usage unit")}
      </label>
      <select
        id={id}
        className={inputClass}
        value={value}
        disabled={units === null}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{units === null ? gt("Loading…") : gt("Choose a unit")}</option>
        {all.map((unit) => (
          <option key={unit} value={unit}>
            {unit}
          </option>
        ))}
      </select>
      {units !== null && units.length === 0 && (
        <p className="mt-1 text-[11px] text-on-surface-faint">
          {gt(
            "No provider has reported usage quantities yet. Usage units appear here once cost data carries them.",
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Which periods the budget covers: the calendar month (the default), a custom
 * cadence (every N days, weeks, months, quarters or years from a start date),
 * or an explicit list of periods each with its own amount.
 */
function BudgetPeriodField({
  id,
  usage,
  value,
  onChange,
}: {
  id: string;
  usage: boolean;
  value: BudgetPeriod | undefined;
  onChange: (period: BudgetPeriod | null) => void;
}) {
  const gt = useGT();
  const mode: PeriodMode = value?.kind ?? "monthly";
  const unitLabels: Record<BudgetPeriodUnit, string> = {
    day: gt("Days"),
    week: gt("Weeks"),
    month: gt("Months"),
    quarter: gt("Quarters"),
    year: gt("Years"),
  };
  const switchMode = (next: PeriodMode) => {
    if (next === mode) return;
    if (next === "monthly") onChange(null);
    else if (next === "recurring") {
      onChange({ kind: "recurring", unit: "week", interval: 1, startDate: todayIso() });
    } else {
      onChange({ kind: "explicit", periods: [blankPeriod(todayIso())] });
    }
  };
  const modeLabels: Record<PeriodMode, string> = {
    monthly: gt("Calendar month"),
    recurring: gt("Custom cadence"),
    explicit: gt("Explicit periods"),
  };

  return (
    <div role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className={labelClass}>
        {gt("Period")}
      </span>
      <div className="flex gap-2 mb-2" role="radiogroup" aria-labelledby={`${id}-label`}>
        {(["monthly", "recurring", "explicit"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={mode === option}
            onClick={() => switchMode(option)}
            className={`px-3 py-1 rounded-lg text-xs border transition-colors ${
              mode === option
                ? "border-blue-500 bg-blue-500/10 text-on-surface"
                : "border-border text-on-surface-secondary hover:bg-surface-sunken"
            }`}
          >
            {modeLabels[option]}
          </button>
        ))}
      </div>

      {value?.kind === "recurring" && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-secondary">
          <span>{gt("Every")}</span>
          <input
            aria-label={gt("Interval count")}
            type="number"
            min={1}
            max={BUDGET_LIMITS.maxInterval}
            className={`${inputClass} w-20`}
            value={value.interval}
            onChange={(e) =>
              onChange({
                ...value,
                interval: Math.max(
                  1,
                  Math.min(BUDGET_LIMITS.maxInterval, Math.round(Number(e.target.value) || 1)),
                ),
              })
            }
          />
          <select
            aria-label={gt("Period unit")}
            className={`${inputClass} w-32`}
            value={value.unit}
            onChange={(e) => onChange({ ...value, unit: e.target.value as BudgetPeriodUnit })}
          >
            {BUDGET_PERIOD_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {unitLabels[unit]}
              </option>
            ))}
          </select>
          <span>{gt("starting")}</span>
          <input
            aria-label={gt("Start date")}
            type="date"
            className={`${inputClass} w-40`}
            value={value.startDate}
            onChange={(e) => onChange({ ...value, startDate: e.target.value })}
          />
        </div>
      )}

      {value?.kind === "explicit" && (
        <div className="space-y-2">
          {value.periods.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                aria-label={gt("Period start")}
                type="date"
                className={`${inputClass} w-36`}
                value={p.start}
                onChange={(e) =>
                  onChange({
                    ...value,
                    periods: value.periods.map((x, j) =>
                      j === i ? { ...x, start: e.target.value } : x,
                    ),
                  })
                }
              />
              <span className="text-xs text-on-surface-secondary">{gt("to")}</span>
              <input
                aria-label={gt("Period end")}
                type="date"
                className={`${inputClass} w-36`}
                value={p.end}
                onChange={(e) =>
                  onChange({
                    ...value,
                    periods: value.periods.map((x, j) =>
                      j === i ? { ...x, end: e.target.value } : x,
                    ),
                  })
                }
              />
              <input
                aria-label={gt("Period amount")}
                type="number"
                min={0}
                step={usage ? "any" : "0.01"}
                className={`${inputClass} w-28`}
                value={
                  usage
                    ? (p.usageAmount ?? "")
                    : p.amountCents !== undefined
                      ? p.amountCents / 100
                      : ""
                }
                onChange={(e) => {
                  const n = Number(e.target.value);
                  const amount = e.target.value === "" || !Number.isFinite(n) ? undefined : n;
                  onChange({
                    ...value,
                    periods: value.periods.map((x, j) =>
                      j === i ? withPeriodAmount(x, usage, amount) : x,
                    ),
                  });
                }}
              />
              {value.periods.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    onChange({ ...value, periods: value.periods.filter((_, j) => j !== i) })
                  }
                  className="text-on-surface-faint hover:text-on-surface-secondary text-xs"
                  title={gt("Remove period")}
                  aria-label={gt("Remove period")}
                >
                  <CloseIcon size={12} />
                </button>
              )}
            </div>
          ))}
          {value.periods.length < BUDGET_LIMITS.maxExplicitPeriods && (
            <button
              type="button"
              onClick={() => {
                const last = value.periods[value.periods.length - 1];
                const start = last?.end ? nextDay(last.end) : todayIso();
                onChange({ ...value, periods: [...value.periods, blankPeriod(start)] });
              }}
              className="text-xs text-info hover:text-info-strong"
            >
              {gt("+ Add period")}
            </button>
          )}
        </div>
      )}

      <p className="mt-1 text-[11px] text-on-surface-faint">
        {mode === "monthly"
          ? gt("Measured from the 1st to the last day of each month (UTC).")
          : mode === "recurring"
            ? gt(
                "Each period starts where the last one ended. Days before the start date are not measured.",
              )
            : gt("Each period has its own amount. Days outside every period are not measured.")}
      </p>
    </div>
  );
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return todayIso();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** A month-long period from `start`, with no amount yet. */
function blankPeriod(start: string): BudgetExplicitPeriod {
  const d = new Date(`${start}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  const end = Number.isNaN(d.getTime()) ? start : d.toISOString().slice(0, 10);
  return { start, end };
}

/** `period` with its amount replaced, in the field its budget's measure uses. */
function withPeriodAmount(
  period: BudgetExplicitPeriod,
  usage: boolean,
  amount: number | undefined,
): BudgetExplicitPeriod {
  const base: BudgetExplicitPeriod = { start: period.start, end: period.end };
  if (amount === undefined) return base;
  return usage
    ? { ...base, usageAmount: amount }
    : { ...base, amountCents: Math.round(amount * 100) };
}

/**
 * The budget this one rolls up into. Only budgets that could legally be the
 * parent are offered: same measure and currency (or usage unit), not this
 * budget or anything below it, and not so deep that the tree would pass the
 * depth limit. The API enforces all of it again; filtering here just keeps
 * the picker from offering choices that would be refused.
 */
function BudgetParentField({
  id,
  budgets,
  budgetId,
  input,
  onChange,
}: {
  id: string;
  budgets: BudgetWithStatus[];
  budgetId: string | null;
  input: BudgetInput;
  onChange: (parentBudgetId: string | null) => void;
}) {
  const gt = useGT();
  const excluded = budgetId ? budgetDescendantIds(budgets, budgetId) : new Set<string>();
  const ownHeight = budgetId ? budgetSubtreeHeight(budgets, budgetId) : 1;
  const usage = input.measure === "usage";
  const candidates = budgets.filter(
    (b) =>
      b.id !== budgetId &&
      !excluded.has(b.id) &&
      (b.measure === "usage") === usage &&
      (usage ? b.usageUnit === input.usageUnit : b.currency === input.currency) &&
      budgetDepth(budgets, b.id) + ownHeight <= BUDGET_LIMITS.maxDepth,
  );
  const current = input.parentBudgetId ?? "";
  const currentMissing = current !== "" && !candidates.some((b) => b.id === current);
  const hasChildren = budgetId ? budgets.some((b) => b.parentBudgetId === budgetId) : false;

  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {gt("Parent budget")}
      </label>
      <select
        id={id}
        className={inputClass}
        value={current}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">{gt("None (top level)")}</option>
        {currentMissing && (
          <option value={current}>
            {budgets.find((b) => b.id === current)?.name ?? gt("Current parent")}
          </option>
        )}
        {candidates.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11px] text-on-surface-faint">
        {hasChildren
          ? gt(
              "This budget has child budgets, so its figures are the sum of theirs over its own period; its scope below is set aside while it has children.",
            )
          : gt(
              "A parent's actual and forecast are the sum of its children's. Only budgets measuring the same currency or usage unit can be parents.",
            )}
      </p>
    </div>
  );
}

/**
 * Who this budget emails when a threshold fires, on top of the org's routing
 * rules. Its own component so the options load only when the host wired them.
 */
function BudgetEmailField({
  api,
  value,
  onChange,
}: {
  api: CostApi;
  value: AlertEmailRecipients;
  onChange: (next: AlertEmailRecipients) => void;
}) {
  const gt = useGT();
  if (!api.getAlertEmailOptions) return null;
  return (
    <LoadedAlertEmailRecipientsField
      load={api.getAlertEmailOptions.bind(api)}
      value={value}
      onChange={onChange}
      description={gt(
        "Emailed each time a threshold fires, in addition to your alert routing rules.",
      )}
    />
  );
}
