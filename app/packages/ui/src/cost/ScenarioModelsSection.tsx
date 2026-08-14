import { useCallback, useEffect, useId, useState } from "react";
import { T, Var, useGT } from "gt-react";

import { Modal } from "../components/Modal.js";
import { CostFilterEditor } from "./CostGraphConfigModal.js";
import {
  COST_SCENARIO_ADJUSTMENT_KINDS,
  COST_SCENARIO_ADJUSTMENT_KIND_DESCRIPTIONS,
  COST_SCENARIO_ADJUSTMENT_KIND_LABELS,
  COST_SCENARIO_LIMITS,
  COST_SCENARIO_PERIODS,
  COST_SCENARIO_PERIOD_LABELS,
  costScenarioModelInputError,
  describeCostScenarioAdjustment,
  describeCostScenarioModel,
  describeCostScenarioReferents,
  type CostFilter,
  type CostScenarioAdjustment,
  type CostScenarioAdjustmentKind,
  type CostScenarioModel,
  type CostScenarioModelInput,
  type CostScenarioReferent,
} from "./config.js";
import type { CostsClient } from "./types.js";
import { parseNumericInputValue } from "../form-values.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

/**
 * Scenario models — the org's named sets of known future cost.
 *
 * Lives on the Costs panel rather than in Settings, and for the same reason
 * saved filters do: a scenario model is a cost object, not a preference. It is
 * read by the cost graphs on this very panel, it can be attached to a budget
 * listed a few sections above, and editing it here changes every projection
 * built on it. Settings is where you configure Infrawrench; this is where you
 * describe your own spend.
 *
 * The editor names the referents before anything is saved for the same reason
 * the saved-filter editor does — and one sharper one: a referent can be a
 * *budget*, and changing the assumptions under a budget changes when somebody
 * gets paged.
 */
export function ScenarioModelsSection({ client }: { client: CostsClient }) {
  const gt = useGT();
  const [models, setModels] = useState<CostScenarioModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ model: CostScenarioModel | null } | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const canWrite = Boolean(
    client.createScenarioModel && client.updateScenarioModel && client.deleteScenarioModel,
  );

  const refresh = useCallback(async () => {
    try {
      setModels((await client.listScenarioModels?.()) ?? []);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function deleteModel(model: CostScenarioModel) {
    if (!window.confirm(gt('Delete the scenario model "{name}"?', { name: model.name }))) return;
    setRowError(null);
    try {
      await client.deleteScenarioModel?.(model.id);
      await refresh();
    } catch (e: unknown) {
      // The interesting failure is the deliberate one: the server refuses while
      // a chart, report or budget still references the model, and its message
      // names them. Show it on the row it belongs to.
      setRowError({ id: model.id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">{gt("Scenario models")}</h2>
          <T>
            <p className="text-xs text-on-surface-faint mt-0.5">
              Known future cost the trend can&rsquo;t see &mdash; a purchase, a new team, a
              migration. Applying one draws a second line beside the forecast; it never replaces it,
              and it never changes recorded spend.
            </p>
          </T>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => setEditing({ model: null })}
            className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            {gt("New scenario")}
          </button>
        )}
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          <T>
            Couldn&rsquo;t load scenario models &mdash; <Var>{error}</Var>{" "}
            <button type="button" onClick={() => void refresh()} className="underline">
              Retry
            </button>
          </T>
        </div>
      )}

      {models === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading scenario models…")}
        </p>
      )}

      {models?.length === 0 && (
        <T>
          <p className="text-sm text-on-surface-faint">
            No scenario models yet. Create one to describe spend you already know is coming &mdash;
            a reserved-instance purchase, a team starting next quarter, a migration that takes a
            fifth off compute.
          </p>
        </T>
      )}

      <ul className="flex flex-col gap-2">
        {(models ?? []).map((model) => (
          <li
            key={model.id}
            className="rounded-xl border border-border bg-surface-raised px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="block truncate text-sm font-medium text-on-surface">
                  {model.name}
                </span>
                {model.description && (
                  <span className="block truncate text-xs text-on-surface-faint mt-0.5">
                    {model.description}
                  </span>
                )}
                <span className="mt-0.5 block text-xs text-on-surface-faint">
                  {describeCostScenarioModel(model)}
                </span>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {model.adjustments.map((adjustment) => (
                    <li key={adjustment.id} className="text-xs text-on-surface-secondary">
                      <span className="text-on-surface">{adjustment.label}</span>{" "}
                      <span className="text-on-surface-faint">
                        {describeCostScenarioAdjustment(adjustment, model.currency)}
                        {adjustment.scope.length > 0 ? " · scoped" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {canWrite && (
                <div className="flex shrink-0 items-center gap-2 text-xs text-on-surface-faint">
                  <button
                    type="button"
                    onClick={() => setEditing({ model })}
                    className="hover:text-on-surface-secondary underline"
                  >
                    {gt("Edit")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteModel(model)}
                    className="hover:text-danger underline"
                  >
                    {gt("Delete")}
                  </button>
                </div>
              )}
            </div>
            {rowError?.id === model.id && (
              <p role="alert" className="mt-1.5 text-xs text-danger">
                {rowError.message}
              </p>
            )}
          </li>
        ))}
      </ul>

      {editing && (
        <ScenarioModelEditModal
          model={editing.model}
          client={client}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </section>
  );
}

function newAdjustment(currency: string): CostScenarioAdjustment {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `a${Date.now()}${Math.random().toString(16).slice(2)}`,
    label: "",
    kind: "one_off",
    startDate: today,
    endDate: null,
    amountCents: 0,
    currency,
    period: null,
    percent: null,
    scope: [],
  };
}

/**
 * Create/edit one scenario model.
 *
 * On edit the referents are loaded and named up front. Saving re-projects every
 * chart drawing this model on its next query — and re-judges the forecast
 * thresholds of any budget that opted into it, which is the sentence that
 * belongs next to the Save button rather than in a changelog.
 */
function ScenarioModelEditModal({
  model,
  client,
  onClose,
  onSaved,
}: {
  model: CostScenarioModel | null;
  client: CostsClient;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const gt = useGT();
  const uid = useId();
  const [name, setName] = useState(model?.name ?? "");
  const [description, setDescription] = useState(model?.description ?? "");
  const [currency, setCurrency] = useState(model?.currency ?? "USD");
  const [adjustments, setAdjustments] = useState<CostScenarioAdjustment[]>(
    model?.adjustments ?? [newAdjustment(model?.currency ?? "USD")],
  );
  const [referents, setReferents] = useState<CostScenarioReferent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    void client
      .getScenarioModelReferents?.(model.id)
      .then((rows) => {
        if (!cancelled) setReferents(rows);
      })
      .catch(() => {
        // Advisory only — the edit still works; the caveat is just unnamed.
        if (!cancelled) setReferents(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, model]);

  const patch = (index: number, over: Partial<CostScenarioAdjustment>) => {
    setAdjustments((rows) => rows.map((r, i) => (i === index ? { ...r, ...over } : r)));
  };

  const save = async () => {
    const code = currency.trim().toUpperCase();
    const input: CostScenarioModelInput = {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      currency: code,
      // Amount rows always carry the model's currency — the field is not
      // separately editable, because a model that holds two currencies is
      // exactly what the contract refuses.
      adjustments: adjustments.map((a) => ({
        ...a,
        label: a.label.trim(),
        currency: a.kind === "rate_change" ? null : code,
      })),
    };
    // The same function the API runs, so the form refuses exactly what the
    // server refuses, in the same words.
    const problem = costScenarioModelInputError(input);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (model) await client.updateScenarioModel?.(model.id, input);
      else await client.createScenarioModel?.(input);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save"));
      setSaving(false);
    }
  };

  const budgetReferents = (referents ?? []).filter((r) => r.kind === "budget");

  return (
    <Modal
      onClose={onClose}
      ariaLabel={model ? gt("Edit {name}", { name: model.name }) : gt("New scenario model")}
    >
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[680px] max-w-full p-6 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {model ? gt("Edit scenario model") : gt("New scenario model")}
        </h2>
        <T>
          <p className="text-xs text-on-surface-faint mb-3">
            Adjustments only ever apply to days after the last day with recorded spend. Recorded
            history is never changed, and the unadjusted trend is always drawn alongside.
          </p>
        </T>
        {model && referents !== null && referents.length > 0 && (
          <p className="text-xs text-warning mb-3">
            {gt("Saving changes {referents}.", {
              referents: describeCostScenarioReferents(referents),
            })}
            {budgetReferents.length > 0 &&
              " " +
                gt(
                  "Those budgets judge their forecast thresholds against this model, so this can change which alerts fire.",
                )}
          </p>
        )}

        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <div>
              <label htmlFor={`${uid}-name`} className={labelClass}>
                {gt("Name")}
              </label>
              <input
                id={`${uid}-name`}
                className={inputClass}
                placeholder={gt("e.g. Q4 plan")}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-currency`} className={labelClass}>
                {gt("Currency")}
              </label>
              <input
                id={`${uid}-currency`}
                className={inputClass}
                placeholder="USD"
                maxLength={3}
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              />
            </div>
          </div>
          <div>
            <label htmlFor={`${uid}-description`} className={labelClass}>
              {gt("Description (optional)")}
            </label>
            <input
              id={`${uid}-description`}
              className={inputClass}
              placeholder={gt("What this scenario assumes")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div role="group" aria-labelledby={`${uid}-rows-label`} className="flex flex-col gap-3">
            <span id={`${uid}-rows-label`} className={labelClass}>
              {gt("Adjustments")}
            </span>
            {adjustments.map((adjustment, index) => (
              <AdjustmentRow
                key={adjustment.id}
                adjustment={adjustment}
                index={index}
                currency={currency}
                client={client}
                onChange={(over) => patch(index, over)}
                onRemove={() => setAdjustments((rows) => rows.filter((_, i) => i !== index))}
              />
            ))}
            <button
              type="button"
              onClick={() => setAdjustments((rows) => [...rows, newAdjustment(currency)])}
              className="self-start rounded-lg border border-dashed border-border px-3 py-1.5 text-sm text-on-surface-secondary hover:border-border-strong"
            >
              {gt("+ Add adjustment")}
            </button>
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

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
              disabled={saving}
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
 * One adjustment inside the editor: the row that says *what* the org already
 * knows is coming, how much of it, when, and to which slice of spend.
 *
 * Split out of the modal because the row is genuinely self-contained — it is
 * fully controlled, holds no state of its own, and everything it needs is the
 * adjustment plus the model's currency. The kind-change rules live here rather
 * than in the parent for the same reason: which fields a kind can carry is a
 * fact about this row, not about the model.
 */
function AdjustmentRow({
  adjustment,
  index,
  currency,
  client,
  onChange,
  onRemove,
}: {
  adjustment: CostScenarioAdjustment;
  /** Position in the list — used only to name the row's controls. */
  index: number;
  /** The model's currency; amount rows never carry their own. */
  currency: string;
  client: CostsClient;
  onChange: (over: Partial<CostScenarioAdjustment>) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  /**
   * Changing the kind clears the fields the new kind cannot carry, rather than
   * leaving them set and letting the API refuse the save. A percent left over
   * from a rate change would otherwise sit invisibly on a one-off.
   */
  const changeKind = (kind: CostScenarioAdjustmentKind) => {
    onChange({
      kind,
      amountCents: kind === "rate_change" ? null : 0,
      currency: kind === "rate_change" ? null : currency,
      period: kind === "recurring" ? "monthly" : null,
      percent: kind === "rate_change" ? -10 : null,
      // Cleared on every kind change, not just into `one_off`: an end date set
      // for a recurring cost rarely means the same thing for a rate change, and
      // an invisible leftover is worse than re-picking it.
      endDate: null,
    });
  };

  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-3 flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <input
          className={inputClass}
          aria-label={gt("Adjustment {n} label", { n: index + 1 })}
          placeholder={gt("What this is — e.g. Annual Datadog licence")}
          value={adjustment.label}
          onChange={(e) => onChange({ label: e.target.value })}
        />
        <button
          type="button"
          aria-label={gt("Remove adjustment {n}", { n: index + 1 })}
          onClick={onRemove}
          className="shrink-0 rounded-lg px-2 py-1.5 text-sm text-on-surface-faint hover:text-danger"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs text-on-surface-faint">
          {gt("Kind")}
          <select
            className={inputClass}
            value={adjustment.kind}
            onChange={(e) => changeKind(e.target.value as CostScenarioAdjustmentKind)}
          >
            {COST_SCENARIO_ADJUSTMENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {COST_SCENARIO_ADJUSTMENT_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>

        {adjustment.kind === "rate_change" ? (
          <label className="flex flex-col text-xs text-on-surface-faint">
            {gt("Percent")}
            <input
              type="number"
              className={inputClass}
              min={COST_SCENARIO_LIMITS.minPercent}
              max={COST_SCENARIO_LIMITS.maxPercent}
              value={adjustment.percent ?? 0}
              onChange={(e) => {
                // A cleared or half-typed field keeps what is stored. Coercing
                // it would write an assumption nobody made — `Number("")` is a
                // silent "no change at all", `Number("-")` is a NaN that
                // travels into the request body — while a deliberate 0 still
                // parses and still saves.
                const percent = parseNumericInputValue(e.target.value);
                if (percent === null) return;
                onChange({ percent });
              }}
            />
          </label>
        ) : (
          <label className="flex flex-col text-xs text-on-surface-faint">
            {gt("Amount ({currency})", { currency })}
            <input
              type="number"
              className={inputClass}
              value={(adjustment.amountCents ?? 0) / 100}
              onChange={(e) => {
                // Same guard as the percent field: an amount cleared mid-edit
                // would otherwise persist as an adjustment of zero, which is a
                // scenario line that quietly does nothing.
                const amount = parseNumericInputValue(e.target.value);
                if (amount === null) return;
                onChange({ amountCents: Math.round(amount * 100) });
              }}
            />
          </label>
        )}

        {adjustment.kind === "recurring" && (
          <label className="flex flex-col text-xs text-on-surface-faint">
            {gt("Every")}
            <select
              className={inputClass}
              value={adjustment.period ?? "monthly"}
              onChange={(e) =>
                onChange({ period: e.target.value as CostScenarioAdjustment["period"] })
              }
            >
              {COST_SCENARIO_PERIODS.map((period) => (
                <option key={period} value={period}>
                  {COST_SCENARIO_PERIOD_LABELS[period]}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col text-xs text-on-surface-faint">
          {adjustment.kind === "one_off" ? gt("On") : gt("From")}
          <input
            type="date"
            className={inputClass}
            value={adjustment.startDate}
            onChange={(e) => onChange({ startDate: e.target.value })}
          />
        </label>

        {adjustment.kind !== "one_off" && (
          <label className="flex flex-col text-xs text-on-surface-faint">
            {gt("Until (optional)")}
            <input
              type="date"
              className={inputClass}
              value={adjustment.endDate ?? ""}
              onChange={(e) => onChange({ endDate: e.target.value || null })}
            />
          </label>
        )}
      </div>

      <p className="text-[11px] text-on-surface-faint">
        {COST_SCENARIO_ADJUSTMENT_KIND_DESCRIPTIONS[adjustment.kind]}
      </p>

      <div>
        <T>
          <span className={labelClass}>
            Scope (optional &mdash; empty is the whole organization)
          </span>
        </T>
        <CostFilterEditor
          filters={adjustment.scope}
          onChange={(scope: CostFilter[]) => onChange({ scope })}
          api={client}
        />
      </div>
    </div>
  );
}
