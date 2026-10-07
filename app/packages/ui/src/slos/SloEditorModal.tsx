import { useEffect, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  SLO_COMPARATORS,
  SLO_DEFAULTS,
  SLO_LIMITS,
  SLO_WINDOW_DAYS,
  formatBudgetDuration,
  sloBudgetTotalMinutes,
  validateSloInput,
  type Slo,
  type SloComparator,
  type SloInput,
  type SloSliKind,
  type SloSourcesResponse,
  type SloWindowDays,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import type { SlosClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

/** Common targets, offered as quick picks beside the free field. */
const TARGET_PRESETS = [99, 99.5, 99.9, 99.95, 99.99];

export interface SloEditorModalProps {
  client: SlosClient;
  /** Existing SLO to edit, or null to create one. */
  existing: Slo | null;
  onSaved: (slo: Slo | null) => void;
  onClose: () => void;
}

function parseNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * The SLO editor. Every source is a picker: probes come from the org's
 * probes, resources and their metric series from what the metric store has
 * actually seen in the last week (`GET /slos/sources`), so nobody types an id
 * or an internal series label.
 */
export function SloEditorModal({ client, existing, onSaved, onClose }: SloEditorModalProps) {
  const gt = useGT();
  const dataString = useDataString();
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [sliKind, setSliKind] = useState<SloSliKind>(existing?.sliKind ?? "probe_availability");
  const [probeId, setProbeId] = useState(existing?.probeId ?? "");
  const [latency, setLatency] = useState(
    String(existing?.latencyThresholdMs ?? SLO_DEFAULTS.latencyThresholdMs),
  );
  const [resourceId, setResourceId] = useState(existing?.resourceId ?? "");
  const [metricKey, setMetricKey] = useState(existing?.metricKey ?? "");
  const [comparator, setComparator] = useState<SloComparator>(
    existing?.comparator ?? SLO_DEFAULTS.comparator,
  );
  const [threshold, setThreshold] = useState(
    existing?.threshold === null || existing?.threshold === undefined
      ? ""
      : String(existing.threshold),
  );
  const [target, setTarget] = useState(
    String(existing?.targetPercent ?? SLO_DEFAULTS.targetPercent),
  );
  const [windowDays, setWindowDays] = useState<SloWindowDays>(
    existing?.windowDays ?? SLO_DEFAULTS.windowDays,
  );
  const [alertsEnabled, setAlertsEnabled] = useState(
    existing?.alertsEnabled ?? SLO_DEFAULTS.alertsEnabled,
  );
  const [suggestFreeze, setSuggestFreeze] = useState(
    existing?.suggestFreeze ?? SLO_DEFAULTS.suggestFreeze,
  );
  const [sources, setSources] = useState<SloSourcesResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listSources()
      .then((s) => {
        if (!cancelled) setSources(s);
      })
      .catch(() => {
        if (!cancelled) setSources({ probes: [], metricResources: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const resource = useMemo(
    () => sources?.metricResources.find((r) => r.resourceId === resourceId) ?? null,
    [sources, resourceId],
  );
  // The stored series stays selectable even if the resource stopped reporting
  // it this week, so editing never silently reassigns what is measured.
  const seriesOptions = useMemo(() => {
    const list = resource?.series ?? [];
    if (metricKey && !list.some((s) => s.label === metricKey)) {
      return [{ label: metricKey, unit: "" }, ...list];
    }
    return list;
  }, [resource, metricKey]);
  const unit = seriesOptions.find((s) => s.label === metricKey)?.unit ?? "";

  const targetNum = parseNumber(target);
  const input: SloInput = {
    name,
    description: description.trim() ? description : null,
    sliKind,
    probeId: probeId || null,
    latencyThresholdMs: parseNumber(latency),
    resourceId: resourceId || null,
    metricKey: metricKey || null,
    comparator,
    threshold: parseNumber(threshold),
    targetPercent: targetNum ?? Number.NaN,
    windowDays,
    alertsEnabled,
    suggestFreeze,
    enabled: existing?.enabled ?? true,
  };
  const budgetHint =
    targetNum !== null && targetNum >= SLO_LIMITS.minTargetPercent && targetNum < 100
      ? gt("Error budget: {duration} of bad minutes per {days} days", {
          duration: formatBudgetDuration(sloBudgetTotalMinutes(targetNum, windowDays)),
          days: windowDays,
        })
      : null;

  const save = async () => {
    const problem = validateSloInput(input);
    if (problem) {
      setError(problem);
      return;
    }
    const mutate = existing ? client.updateSlo : client.createSlo;
    if (!mutate) {
      setError(gt("SLO editing isn't available here."));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = existing
        ? await client.updateSlo!(existing.id, input)
        : await client.createSlo!(input);
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save the SLO"));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    if (!saving) onClose();
  };

  const isProbe = sliKind === "probe_availability" || sliKind === "probe_latency";

  return (
    <Modal onClose={dismiss} ariaLabel={existing ? gt("Edit SLO") : gt("New SLO")}>
      <div className="w-[32rem] max-w-[92vw] max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-xl">
        <h2 className="text-sm font-semibold text-on-surface">
          {existing ? gt("Edit SLO") : gt("New SLO")}
        </h2>
        <p className="mt-1 text-xs text-on-surface-secondary">
          {gt(
            "Every minute with data is one event. The SLI is the share of good minutes over the rolling window, and the error budget is what the target leaves over.",
          )}
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <div>
            <label className={labelClass} htmlFor="slo-name">
              {gt("Name")}
            </label>
            <input
              id="slo-name"
              type="text"
              maxLength={SLO_LIMITS.maxNameLength}
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={gt("Checkout API availability")}
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="slo-description">
              {gt("Description (optional)")}
            </label>
            <input
              id="slo-description"
              type="text"
              maxLength={SLO_LIMITS.maxDescriptionLength}
              className={inputClass}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="slo-kind">
              {gt("Measure")}
            </label>
            <select
              id="slo-kind"
              className={inputClass}
              value={sliKind}
              onChange={(e) => setSliKind(e.target.value as SloSliKind)}
            >
              <option value="probe_availability">
                {gt("Probe availability (checks that succeed)")}
              </option>
              <option value="probe_latency">
                {gt("Probe latency (checks under a threshold)")}
              </option>
              <option value="metric_threshold">{gt("Resource metric against a threshold")}</option>
            </select>
          </div>

          {isProbe && (
            <div>
              <label className={labelClass} htmlFor="slo-probe">
                {gt("Probe")}
              </label>
              <select
                id="slo-probe"
                className={inputClass}
                value={probeId}
                onChange={(e) => {
                  setProbeId(e.target.value);
                  const picked = sources?.probes.find((p) => p.id === e.target.value);
                  if (picked && !name.trim()) setName(picked.name);
                }}
              >
                <option value="" disabled>
                  {sources === null
                    ? gt("Loading probes…")
                    : sources.probes.length > 0
                      ? gt("Pick a probe…")
                      : gt("No probes yet: create one on the Probes page first")}
                </option>
                {existing?.probeId && !sources?.probes.some((p) => p.id === existing.probeId) && (
                  <option value={existing.probeId}>
                    {existing.probeName ?? gt("Deleted probe")}
                  </option>
                )}
                {(sources?.probes ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.url})
                  </option>
                ))}
              </select>
            </div>
          )}

          {sliKind === "probe_latency" && (
            <div>
              <label className={labelClass} htmlFor="slo-latency">
                {gt("Good at or under (ms)")}
              </label>
              <input
                id="slo-latency"
                type="number"
                min={SLO_LIMITS.minLatencyThresholdMs}
                max={SLO_LIMITS.maxLatencyThresholdMs}
                className={inputClass}
                value={latency}
                onChange={(e) => setLatency(e.target.value)}
              />
            </div>
          )}

          {sliKind === "metric_threshold" && (
            <>
              <div>
                <label className={labelClass} htmlFor="slo-resource">
                  {gt("Resource")}
                </label>
                <select
                  id="slo-resource"
                  className={inputClass}
                  value={resourceId}
                  onChange={(e) => {
                    setResourceId(e.target.value);
                    setMetricKey("");
                  }}
                >
                  <option value="" disabled>
                    {sources === null
                      ? gt("Loading resources…")
                      : sources.metricResources.length > 0
                        ? gt("Pick a resource that reports metrics…")
                        : gt("No resource has reported metrics in the last week")}
                  </option>
                  {existing?.resourceId &&
                    !sources?.metricResources.some((r) => r.resourceId === existing.resourceId) && (
                      <option value={existing.resourceId}>
                        {existing.resourceName ?? gt("Deleted resource")}
                      </option>
                    )}
                  {(sources?.metricResources ?? []).map((r) => (
                    <option key={r.resourceId} value={r.resourceId}>
                      {r.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor="slo-metric">
                  {gt("Metric")}
                </label>
                <select
                  id="slo-metric"
                  className={inputClass}
                  value={metricKey}
                  disabled={!resourceId}
                  onChange={(e) => setMetricKey(e.target.value)}
                >
                  <option value="" disabled>
                    {gt("Pick a metric…")}
                  </option>
                  {seriesOptions.map((s) => (
                    <option key={s.label} value={s.label}>
                      {dataString(s.label)}
                      {s.unit ? ` (${s.unit})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass} htmlFor="slo-comparator">
                    {gt("A minute is good when the value is")}
                  </label>
                  <select
                    id="slo-comparator"
                    className={inputClass}
                    value={comparator}
                    onChange={(e) => setComparator(e.target.value as SloComparator)}
                  >
                    {SLO_COMPARATORS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor="slo-threshold">
                    {unit ? gt("Threshold ({unit})", { unit }) : gt("Threshold")}
                  </label>
                  <input
                    id="slo-threshold"
                    type="number"
                    className={inputClass}
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                  />
                </div>
              </div>
            </>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="slo-target">
                {gt("Target (%)")}
              </label>
              <input
                id="slo-target"
                type="number"
                step="0.01"
                min={SLO_LIMITS.minTargetPercent}
                max={SLO_LIMITS.maxTargetPercent}
                className={inputClass}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                list="slo-target-presets"
              />
              <datalist id="slo-target-presets">
                {TARGET_PRESETS.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </div>
            <div>
              <label className={labelClass} htmlFor="slo-window">
                {gt("Rolling window")}
              </label>
              <select
                id="slo-window"
                className={inputClass}
                value={windowDays}
                onChange={(e) => setWindowDays(Number(e.target.value) as SloWindowDays)}
              >
                {SLO_WINDOW_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {gt("{days} days", { days: d })}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {budgetHint && <p className="text-xs text-on-surface-faint -mt-1">{budgetHint}</p>}

          <label className="flex items-start gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={alertsEnabled}
              onChange={(e) => setAlertsEnabled(e.target.checked)}
            />
            <span>
              {gt("Alert on burn rate")}
              <span className="block text-xs text-on-surface-faint">
                {gt(
                  "Pages on a fast burn, opens a ticket-level alert on a slow one, through your alert routing rules.",
                )}
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm text-on-surface">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={suggestFreeze}
              onChange={(e) => setSuggestFreeze(e.target.checked)}
            />
            <span>
              {gt("Suggest a change freeze when the budget runs out")}
              <span className="block text-xs text-on-surface-faint">
                {gt("A suggestion only: nothing is frozen until somebody starts the freeze.")}
              </span>
            </span>
          </label>

          {error !== null && (
            <div role="alert" className="text-sm text-danger">
              {error}
            </div>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={dismiss}
              disabled={saving}
              className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {saving ? gt("Saving…") : existing ? gt("Save") : gt("Create SLO")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
