import { useEffect, useId, useState } from "react";
import { useGT } from "gt-react";

import {
  COST_FORECAST_LIMITS,
  costForecastInputError,
  type CostForecast,
  type CostForecastInput,
} from "@infrawrench/client-core";
import type { BusinessMetric, CostScenarioModel } from "../cost/config.js";
import { Modal } from "../components/Modal.js";
import type { CostReportsClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

export interface CostForecastModalProps {
  /** The forecast being edited, or null to create one. */
  forecast: CostForecast | null;
  client: CostReportsClient;
  onSave: (input: CostForecastInput) => Promise<void>;
  onClose: () => void;
}

/**
 * Create or edit one named forecast: a name, the scenario models it stacks (in
 * order, reorderable), an optional driver metric, and whether it is the
 * report's default. Every reference is picked from a list, never typed.
 *
 * Validation is {@link costForecastInputError}, the function the API runs, so
 * the form refuses exactly what the server would.
 */
export function CostForecastModal({ forecast, client, onSave, onClose }: CostForecastModalProps) {
  const gt = useGT();
  const uid = useId();
  const [name, setName] = useState(forecast?.name ?? "");
  const [description, setDescription] = useState(forecast?.description ?? "");
  const [modelIds, setModelIds] = useState<string[]>(forecast?.scenarioModelIds ?? []);
  const [driverMetricId, setDriverMetricId] = useState<string>(forecast?.driverMetricId ?? "");
  const [isDefault, setIsDefault] = useState(forecast?.isDefault ?? false);
  const [models, setModels] = useState<CostScenarioModel[] | null>(null);
  const [metrics, setMetrics] = useState<BusinessMetric[] | null>(null);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [m, b] = await Promise.all([
          client.listScenarioModels?.() ?? Promise.resolve([]),
          client.listBusinessMetrics?.() ?? Promise.resolve([]),
        ]);
        if (cancelled) return;
        setModels(m);
        setMetrics(b);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const modelName = (id: string) => models?.find((m) => m.id === id)?.name ?? id;
  const available = (models ?? []).filter((m) => !modelIds.includes(m.id));

  function move(index: number, by: -1 | 1) {
    setModelIds((ids) => {
      const next = [...ids];
      const target = index + by;
      if (target < 0 || target >= next.length) return ids;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  async function submit() {
    const input: CostForecastInput = {
      name,
      description: description.trim() || null,
      scenarioModelIds: modelIds,
      driverMetricId: driverMetricId || null,
      isDefault,
    };
    const problem = costForecastInputError(input);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(input);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={forecast ? gt("Edit forecast") : gt("New forecast")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[520px] max-w-[95vw] max-h-[85vh] overflow-y-auto p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {forecast ? gt("Edit forecast") : gt("New forecast")}
        </h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {gt(
            "Start from the automatic trend, or from a business metric's planned values, then stack scenario models on top. Models apply in the order listed.",
          )}
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <div>
            <label className={labelClass} htmlFor={`${uid}-name`}>
              {gt("Name")}
            </label>
            <input
              id={`${uid}-name`}
              className={inputClass}
              value={name}
              maxLength={COST_FORECAST_LIMITS.maxNameLength}
              onChange={(e) => setName(e.target.value)}
              placeholder={gt("e.g. Plan with EU launch")}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${uid}-description`}>
              {gt("Description (optional)")}
            </label>
            <input
              id={`${uid}-description`}
              className={inputClass}
              value={description}
              maxLength={COST_FORECAST_LIMITS.maxDescriptionLength}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div>
            <label className={labelClass} htmlFor={`${uid}-driver`}>
              {gt("Baseline")}
            </label>
            <select
              id={`${uid}-driver`}
              className={inputClass}
              value={driverMetricId}
              onChange={(e) => setDriverMetricId(e.target.value)}
            >
              <option value="">{gt("Automatic trend")}</option>
              {(metrics ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {gt("Driven by {metric} (unit cost × planned {unit})", {
                    metric: m.name,
                    unit: m.unit,
                  })}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-on-surface-faint">
              {driverMetricId
                ? gt(
                    "Projects this report's spend per unit forward and multiplies it by the metric's forecasted values. Add those under Costs, Unit costs, Values.",
                  )
                : gt("Extends the trend of the last 30 days of this report's spend.")}
            </p>
          </div>

          <div>
            <span className={labelClass}>{gt("Scenario models, in order")}</span>
            {modelIds.length === 0 ? (
              <p className="text-xs text-on-surface-faint">{gt("None yet.")}</p>
            ) : (
              <ol className="flex flex-col gap-1">
                {modelIds.map((id, i) => (
                  <li
                    key={id}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-sm"
                  >
                    <span className="min-w-0 truncate text-on-surface">
                      {i + 1}. {modelName(id)}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-xs">
                      <button
                        type="button"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                        aria-label={gt("Move {name} up", { name: modelName(id) })}
                        className="text-on-surface-faint hover:text-on-surface-secondary disabled:opacity-40"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={i === modelIds.length - 1}
                        onClick={() => move(i, 1)}
                        aria-label={gt("Move {name} down", { name: modelName(id) })}
                        className="text-on-surface-faint hover:text-on-surface-secondary disabled:opacity-40"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => setModelIds((ids) => ids.filter((x) => x !== id))}
                        className="text-on-surface-faint underline hover:text-danger"
                      >
                        {gt("Remove")}
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {models !== null && available.length > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <select
                  aria-label={gt("Scenario model to add")}
                  className={inputClass}
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                >
                  <option value="">{gt("Add a scenario model…")}</option>
                  {available.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!adding || modelIds.length >= COST_FORECAST_LIMITS.maxScenarioModels}
                  onClick={() => {
                    setModelIds((ids) => [...ids, adding]);
                    setAdding("");
                  }}
                  className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
                >
                  {gt("Add")}
                </button>
              </div>
            )}
            {models !== null && models.length === 0 && (
              <p className="mt-1 text-[11px] text-on-surface-faint">
                {gt("No scenario models yet. Create them under Costs, Scenario models.")}
              </p>
            )}
            <p className="mt-1 text-[11px] text-on-surface-faint">
              {gt(
                "Each model adjusts the line the ones above it produced, so an org-wide percentage further down also scales amounts added earlier.",
              )}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            {gt("Show this forecast by default on the report")}
          </label>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? gt("Saving…") : gt("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
