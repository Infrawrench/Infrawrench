import { useEffect, useMemo, useState } from "react";
import {
  ENVIRONMENT_LIMITS,
  resolveParameterValues,
  validateParameterValues,
  validateTtlHours,
  type EnvironmentCostEstimate,
} from "@infrawrench/client-core";
import type {
  EnvironmentInstance,
  EnvironmentSettings,
  EnvironmentTemplate,
  EnvironmentsClient,
} from "./types.js";

export interface InstantiateModalProps {
  client: EnvironmentsClient;
  template: EnvironmentTemplate;
  settings: EnvironmentSettings;
  onClose(): void;
  onCreated(instance: EnvironmentInstance): void;
}

const TTL_PRESETS = [
  { hours: 4, label: "4 hours" },
  { hours: 24, label: "1 day" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "1 week" },
];

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * The instantiate form. Three guardrails are visible rather than implied: the
 * TTL is a required field with the org's ceiling stated on it, the cost
 * estimate is fetched before the button does anything, and an unpriced member
 * says so instead of quietly not counting.
 */
export function InstantiateModal({
  client,
  template,
  settings,
  onClose,
  onCreated,
}: InstantiateModalProps) {
  const [name, setName] = useState("");
  // null is "the field is empty". Coercing an empty input with Number() would
  // store 0, which both renders as a value the user never typed and reads as
  // "zero hours" rather than "unanswered".
  const [ttlHours, setTtlHours] = useState<number | null>(settings.defaultTtlHours);
  const [values, setValues] = useState<Record<string, string>>(() =>
    resolveParameterValues(template, {}),
  );
  const [note, setNote] = useState("");
  const [estimate, setEstimate] = useState<EnvironmentCostEstimate | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ttlProblem =
    ttlHours === null ? "A time-to-live is required." : validateTtlHours(ttlHours, settings);
  const parameterProblem = validateParameterValues(template, values);

  const presets = useMemo(
    () => TTL_PRESETS.filter((preset) => preset.hours <= settings.maxTtlHours),
    [settings.maxTtlHours],
  );

  // Re-price on every parameter change, debounced the same 220ms the create
  // form uses — a size or region swap is exactly when the number matters.
  useEffect(() => {
    if (!client.estimate) return;
    if (parameterProblem) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      client
        .estimate?.(template.id, { parameters: values })
        .then((next) => {
          if (!cancelled) setEstimate(next);
        })
        .catch(() => {
          if (!cancelled) setEstimate(null);
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, template.id, values, parameterProblem]);

  const submit = async () => {
    if (!client.instantiate || ttlHours === null) return;
    setBusy(true);
    setError(null);
    try {
      const instance = await client.instantiate(template.id, {
        name: name.trim(),
        ttlHours,
        parameters: values,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (instance) onCreated(instance);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the environment");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl border border-border bg-surface-raised p-5">
        <h3 className="text-base font-semibold text-on-surface">
          Stamp out &ldquo;{template.name}&rdquo;
        </h3>
        <p className="mt-1 text-xs text-on-surface-faint">
          {template.members.length} resource{template.members.length === 1 ? "" : "s"}, created in
          dependency order and named with this environment&apos;s prefix.
        </p>

        <label className="mt-4 block text-xs text-on-surface-secondary">
          Environment name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="pr-482"
            className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
          />
        </label>

        <div className="mt-4">
          <span className="text-xs text-on-surface-secondary">
            Time to live — required, at most {settings.maxTtlHours}h
          </span>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {presets.map((preset) => (
              <button
                key={preset.hours}
                type="button"
                onClick={() => setTtlHours(preset.hours)}
                className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                  ttlHours === preset.hours
                    ? "bg-blue-600 text-white"
                    : "bg-surface-sunken text-on-surface-secondary hover:bg-surface"
                }`}
              >
                {preset.label}
              </button>
            ))}
            <input
              type="number"
              min={ENVIRONMENT_LIMITS.minTtlHours}
              max={settings.maxTtlHours}
              value={ttlHours ?? ""}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                setTtlHours(e.target.value === "" || Number.isNaN(parsed) ? null : parsed);
              }}
              className="w-20 rounded-lg border border-border bg-surface px-2 py-1 text-xs text-on-surface"
              aria-label="Time to live in hours"
            />
            <span className="text-xs text-on-surface-faint">hours</span>
          </div>
          {ttlProblem && <p className="mt-1 text-xs text-danger">{ttlProblem}</p>}
        </div>

        {template.parameters.length > 0 && (
          <div className="mt-4 space-y-3">
            {template.parameters.map((parameter) => (
              <label key={parameter.key} className="block text-xs text-on-surface-secondary">
                {parameter.label}
                {parameter.type === "select" ? (
                  <select
                    value={values[parameter.key] ?? ""}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [parameter.key]: e.target.value }))
                    }
                    className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
                  >
                    {(parameter.options ?? []).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={parameter.type === "number" ? "number" : "text"}
                    value={values[parameter.key] ?? ""}
                    onChange={(e) =>
                      setValues((prev) => ({ ...prev, [parameter.key]: e.target.value }))
                    }
                    className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
                  />
                )}
              </label>
            ))}
            {parameterProblem && <p className="text-xs text-danger">{parameterProblem}</p>}
          </div>
        )}

        <label className="mt-4 block text-xs text-on-surface-secondary">
          Note (optional)
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Reviewing #482"
            className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
          />
        </label>

        <div className="mt-4 rounded-lg border border-border bg-surface px-3 py-2">
          <span className="text-xs text-on-surface-secondary">Estimated cost</span>
          {estimate === undefined && (
            <p className="text-sm text-on-surface-faint">Pricing this environment…</p>
          )}
          {estimate === null && (
            <p className="text-sm text-on-surface-faint">
              This environment could not be priced — that is not the same as free.
            </p>
          )}
          {estimate && (
            <p className="text-sm text-on-surface">
              {estimate.monthlyAmount === null || estimate.currency === null
                ? "Could not be priced"
                : `${estimate.partial ? "At least " : ""}${formatMoney(
                    estimate.monthlyAmount,
                    estimate.currency,
                  )}/month`}
              {estimate.unpricedCount > 0 && (
                <span className="text-on-surface-faint">
                  {" "}
                  · {estimate.unpricedCount} resource
                  {estimate.unpricedCount === 1 ? "" : "s"} unpriced
                </span>
              )}
            </p>
          )}
          {estimate && estimate.monthlyAmount !== null && ttlHours !== null && (
            <p className="text-xs text-on-surface-faint">
              Charged only while it lives — {ttlHours}h is about{" "}
              {((estimate.monthlyAmount * ttlHours) / 730).toFixed(2)} {estimate.currency}.
            </p>
          )}
        </div>

        {error && <p className="mt-3 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary transition-colors hover:bg-surface-sunken"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={
              busy || name.trim() === "" || ttlProblem !== null || parameterProblem !== null
            }
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create environment"}
          </button>
        </div>
      </div>
    </div>
  );
}
