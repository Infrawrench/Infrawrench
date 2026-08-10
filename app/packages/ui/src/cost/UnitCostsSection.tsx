import { useCallback, useEffect, useId, useState } from "react";

import { Modal } from "../components/Modal.js";
import { CostFilterEditor } from "./CostGraphConfigModal.js";
import {
  BUSINESS_METRIC_KEY_HELP,
  BUSINESS_METRIC_KINDS,
  BUSINESS_METRIC_KIND_DESCRIPTIONS,
  BUSINESS_METRIC_KIND_LABELS,
  BUSINESS_METRIC_LIMITS,
  DEFAULT_BUSINESS_METRIC_INPUT,
  normalizeBusinessMetricKey,
  type BusinessMetric,
  type BusinessMetricInput,
  type BusinessMetricKind,
  type BusinessMetricValue,
  type CostFilter,
} from "./config.js";
import type { CostsClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

function metricToInput(metric: BusinessMetric): BusinessMetricInput {
  return {
    key: metric.key,
    name: metric.name,
    unit: metric.unit,
    kind: metric.kind,
    costScope: metric.costScope,
    ...(metric.description ? { description: metric.description } : {}),
    ...(metric.currency ? { currency: metric.currency } : {}),
    // Round-tripped, or renaming a metric would quietly detach the saved filter
    // scoping its numerator — updates are full replaces.
    ...(metric.savedFilterId ? { savedFilterId: metric.savedFilterId } : {}),
  };
}

/**
 * How much of a metric's history is actually reported, as one short phrase.
 *
 * A metric that exists but is not being fed draws a chart made entirely of
 * gaps, and the failure is silent everywhere else: the definition looks fine,
 * the workflow that should be writing it may have been failing for weeks. So
 * the list says it here, and says it in terms of days rather than a date range,
 * because "42 of 90 days" is the sentence that makes someone go and look.
 */
function describeCoverage(metric: BusinessMetric): string {
  if (!metric.coverage) return "No values reported yet — unit costs will be one continuous gap.";
  const { firstDay, lastDay, reportedDays } = metric.coverage;
  const span =
    Math.round(
      (new Date(`${lastDay}T00:00:00Z`).getTime() - new Date(`${firstDay}T00:00:00Z`).getTime()) /
        86_400_000,
    ) + 1;
  const sparse = reportedDays < span ? ` (${span - reportedDays} missing)` : "";
  return `${reportedDays} day${reportedDays === 1 ? "" : "s"} reported, ${firstDay} → ${lastDay}${sparse}`;
}

/**
 * Business metrics — the denominators unit costs divide by.
 *
 * Lives on the Costs panel, next to saved filters and budgets, because a metric
 * is a cost object rather than a preference: it names a slice of spend and it
 * is what every unit-cost card on every dashboard divides by. Editing a
 * metric's scope here changes what those cards mean, which is why the editor
 * carries the same filter editor a graph does rather than a simplified one.
 */
export function UnitCostsSection({ client }: { client: CostsClient }) {
  const [metrics, setMetrics] = useState<BusinessMetric[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ metric: BusinessMetric | null } | null>(null);
  const [reporting, setReporting] = useState<BusinessMetric | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const list = client.listBusinessMetrics;
  const canWrite = Boolean(
    client.createBusinessMetric && client.updateBusinessMetric && client.deleteBusinessMetric,
  );

  const refresh = useCallback(async () => {
    if (!list) return;
    try {
      setMetrics(await list());
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [list]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A host that hasn't wired the endpoint doesn't render the section at all,
  // the same rule the anomalies and commitments sections follow.
  if (!list) return null;

  async function save(input: BusinessMetricInput) {
    if (editing?.metric) await client.updateBusinessMetric?.(editing.metric.id, input);
    else await client.createBusinessMetric?.(input);
    setEditing(null);
    await refresh();
  }

  async function remove(metric: BusinessMetric) {
    if (
      !window.confirm(
        `Delete the metric "${metric.name}"? Its reported values go with it, and any unit-cost ` +
          "card using it will show an error rather than falling back to plain spend.",
      )
    ) {
      return;
    }
    setRowError(null);
    try {
      await client.deleteBusinessMetric?.(metric.id);
      await refresh();
    } catch (e: unknown) {
      setRowError({ id: metric.id, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">Unit costs</h2>
          <p className="text-xs text-on-surface-faint mt-0.5">
            What one of the things you do costs. Declare the number your business runs on —
            customers, requests, GB — report it daily, and any cost graph can divide spend by it.
          </p>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={() => setEditing({ metric: null })}
            className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            New metric
          </button>
        )}
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-red-500">
          Couldn&rsquo;t load business metrics — {error}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            Retry
          </button>
        </div>
      )}

      {metrics === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Loading business metrics…
        </p>
      )}

      {metrics?.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          No business metrics yet. Add one, then report its daily values from a workflow with{" "}
          <code className="text-on-surface-secondary">infra.businessMetrics.write</code>, over the
          API, or by hand.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {(metrics ?? []).map((metric) => (
          <li
            key={metric.id}
            className="rounded-xl border border-border bg-surface-raised px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="block truncate text-sm font-medium text-on-surface">
                  {metric.name} <code className="text-xs text-on-surface-faint">{metric.key}</code>
                </span>
                <span className="block text-xs text-on-surface-faint mt-0.5">
                  per {metric.unit}
                  {metric.kind === "currency" ? ` · revenue in ${metric.currency}` : ""}
                  {metric.costScope.length > 0
                    ? ` · scoped to ${metric.costScope.length} filter${metric.costScope.length === 1 ? "" : "s"}`
                    : " · all spend"}
                </span>
                <span
                  className={`block text-xs mt-0.5 ${metric.coverage ? "text-on-surface-faint" : "text-amber-500"}`}
                >
                  {describeCoverage(metric)}
                </span>
                {metric.description && (
                  <span className="block text-xs text-on-surface-faint mt-0.5">
                    {metric.description}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs">
                {client.listBusinessMetricValues && (
                  <button
                    type="button"
                    onClick={() => setReporting(metric)}
                    className="text-on-surface-secondary hover:text-on-surface underline"
                  >
                    Values
                  </button>
                )}
                {canWrite && (
                  <>
                    <button
                      type="button"
                      onClick={() => setEditing({ metric })}
                      className="text-on-surface-secondary hover:text-on-surface underline"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(metric)}
                      className="text-on-surface-faint hover:text-red-500 underline"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
            {rowError?.id === metric.id && (
              <p role="alert" className="mt-2 text-xs text-red-500">
                {rowError.message}
              </p>
            )}
          </li>
        ))}
      </ul>

      {editing && (
        <BusinessMetricModal
          initialInput={
            editing.metric ? metricToInput(editing.metric) : DEFAULT_BUSINESS_METRIC_INPUT
          }
          isNew={!editing.metric}
          api={client}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}

      {reporting && (
        <MetricValuesModal
          metric={reporting}
          client={client}
          onClose={() => setReporting(null)}
          onChanged={refresh}
        />
      )}
    </section>
  );
}

/** Create/edit a metric definition. */
function BusinessMetricModal({
  initialInput,
  isNew,
  api,
  onSave,
  onClose,
}: {
  initialInput: BusinessMetricInput;
  isNew: boolean;
  api: CostsClient;
  onSave: (input: BusinessMetricInput) => Promise<void>;
  onClose: () => void;
}) {
  const uid = useId();
  const [input, setInput] = useState<BusinessMetricInput>(initialInput);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof BusinessMetricInput>(key: K, value: BusinessMetricInput[K]) =>
    setInput((prev) => ({ ...prev, [key]: value }));

  function setKind(kind: BusinessMetricKind) {
    // Clearing the currency when leaving `currency` is not cosmetic: the server
    // and the database both reject a count metric that carries one, so leaving
    // a stale code behind would make the form fail on save for a field the user
    // can no longer see.
    setInput((prev) => ({
      ...prev,
      kind,
      ...(kind === "currency" ? { currency: prev.currency ?? "USD" } : { currency: undefined }),
    }));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSave(input);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const valid =
    input.key.trim().length > 0 &&
    input.name.trim().length > 0 &&
    input.unit.trim().length > 0 &&
    (input.kind !== "currency" || !!input.currency?.trim());

  return (
    <Modal onClose={onClose} ariaLabel={isNew ? "New business metric" : "Edit business metric"}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[560px] max-h-[85vh] overflow-y-auto p-6">
        <h2 className="text-base font-semibold text-on-surface mb-4">
          {isNew ? "New business metric" : "Edit business metric"}
        </h2>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-red-500">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor={`${uid}-name`}>
                Name
              </label>
              <input
                id={`${uid}-name`}
                className={inputClass}
                value={input.name}
                maxLength={BUSINESS_METRIC_LIMITS.maxNameLength}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Active customers"
              />
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-key`}>
                Key
              </label>
              <input
                id={`${uid}-key`}
                className={inputClass}
                value={input.key}
                maxLength={BUSINESS_METRIC_LIMITS.maxKeyLength}
                onChange={(e) => set("key", normalizeBusinessMetricKey(e.target.value))}
                placeholder="active-customers"
              />
              <p className="text-[11px] text-on-surface-faint mt-1">{BUSINESS_METRIC_KEY_HELP}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor={`${uid}-unit`}>
                Unit (singular)
              </label>
              <input
                id={`${uid}-unit`}
                className={inputClass}
                value={input.unit}
                maxLength={BUSINESS_METRIC_LIMITS.maxUnitLength}
                onChange={(e) => set("unit", e.target.value)}
                placeholder="customer"
              />
              <p className="text-[11px] text-on-surface-faint mt-1">
                The noun in &ldquo;USD per customer&rdquo;.
              </p>
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-kind`}>
                Kind
              </label>
              <select
                id={`${uid}-kind`}
                className={inputClass}
                value={input.kind}
                onChange={(e) => setKind(e.target.value as BusinessMetricKind)}
              >
                {BUSINESS_METRIC_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {BUSINESS_METRIC_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-on-surface-faint mt-1">
                {BUSINESS_METRIC_KIND_DESCRIPTIONS[input.kind]}
              </p>
            </div>
          </div>

          {input.kind === "currency" && (
            <div>
              <label className={labelClass} htmlFor={`${uid}-currency`}>
                Revenue currency
              </label>
              <input
                id={`${uid}-currency`}
                className={inputClass}
                value={input.currency ?? ""}
                maxLength={3}
                onChange={(e) => set("currency", e.target.value.toUpperCase())}
                placeholder="USD"
              />
              <p className="text-[11px] text-on-surface-faint mt-1">
                Margin subtracts spend from revenue, so both have to be in this currency. Spend in a
                currency you have stated no rate for is shown as a gap rather than folded in.
              </p>
            </div>
          )}

          <div>
            <label className={labelClass} htmlFor={`${uid}-description`}>
              Description (optional)
            </label>
            <input
              id={`${uid}-description`}
              className={inputClass}
              value={input.description ?? ""}
              maxLength={BUSINESS_METRIC_LIMITS.maxDescriptionLength}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Paying customers at the end of each UTC day"
            />
          </div>

          <div>
            <span className={labelClass}>Spend this metric divides</span>
            <p className="text-[11px] text-on-surface-faint mb-2">
              Empty means all of your spend. A unit-cost graph can narrow this further, but never
              widen it — the scope is part of what the metric means.
            </p>
            <CostFilterEditor
              filters={input.costScope ?? []}
              onChange={(filters: CostFilter[]) => set("costScope", filters)}
              api={api}
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !valid}
            onClick={() => void submit()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * A metric's reported days, and a way to add or correct one by hand.
 *
 * The manual entry exists because the automated path fails quietly: a workflow
 * that stopped writing leaves a chart full of gaps and no error anywhere. Being
 * able to type yesterday's number in and watch the gap close is how someone
 * confirms the metric is wired up at all.
 */
function MetricValuesModal({
  metric,
  client,
  onClose,
  onChanged,
}: {
  metric: BusinessMetric;
  client: CostsClient;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const uid = useId();
  const [values, setValues] = useState<BusinessMetricValue[] | null>(null);
  const [day, setDay] = useState(() =>
    new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
  );
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = client.listBusinessMetricValues;
  const write = client.writeBusinessMetricValues;

  const refresh = useCallback(async () => {
    if (!load) return;
    try {
      setValues(await load(metric.id, 60));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load, metric.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit() {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed)) {
      setError("Enter a number.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await write?.(metric.id, [{ date: day, value: parsed }]);
      setAmount("");
      await refresh();
      await onChanged();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={`Values for ${metric.name}`}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[460px] max-h-[85vh] overflow-y-auto p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">{metric.name}</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          One value per UTC day, in {metric.unit}s. Reporting a day again replaces it rather than
          adding to it, so a nightly job is safe to re-run.
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-red-500">
            {error}
          </div>
        )}

        {write && (
          <div className="flex items-end gap-2 mb-4">
            <div className="flex-1">
              <label className={labelClass} htmlFor={`${uid}-day`}>
                Day
              </label>
              <input
                id={`${uid}-day`}
                type="date"
                className={inputClass}
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <label className={labelClass} htmlFor={`${uid}-value`}>
                Value
              </label>
              <input
                id={`${uid}-value`}
                className={inputClass}
                value={amount}
                inputMode="decimal"
                onChange={(e) => setAmount(e.target.value)}
                placeholder="310"
              />
            </div>
            <button
              type="button"
              disabled={busy || amount.trim() === ""}
              onClick={() => void submit()}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            >
              Report
            </button>
          </div>
        )}

        {values === null && error === null && (
          <p role="status" className="text-sm text-on-surface-faint">
            Loading values…
          </p>
        )}
        {values?.length === 0 && (
          <p className="text-sm text-on-surface-faint">
            Nothing reported yet — every unit-cost chart for this metric is one continuous gap.
          </p>
        )}

        <ul className="flex flex-col">
          {(values ?? []).map((value) => (
            <li
              key={value.day}
              className="flex items-center justify-between gap-3 border-b border-border py-1.5 text-sm last:border-0"
            >
              <span className="text-on-surface-secondary">{value.day}</span>
              <span className="text-on-surface tabular-nums">{value.value}</span>
              <span className="text-xs text-on-surface-faint">{value.source}</span>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}
