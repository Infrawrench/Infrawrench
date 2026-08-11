import {
  COST_ALERT_LIMITS,
  COST_CHANGE_CADENCES,
  COST_CHANGE_CADENCE_DESCRIPTIONS,
  COST_CHANGE_CADENCE_LABELS,
  COST_CHANGE_DIRECTIONS,
  COST_CHANGE_DIRECTION_LABELS,
  COST_DIMENSION_LABELS,
  DEFAULT_COST_ALERT_INPUT,
  costAlertEventDeltaLabel,
  type CostAlert,
  type CostAlertEvent,
  type CostAlertInput,
  type CostChangeCadence,
  type CostChangeDirection,
  type CostDimensionId,
} from "@infrawrench/client-core";
import { useEffect, useId, useState } from "react";

import { COST_DIMENSIONS, costAlertInputSchema, type CostFilter } from "./config.js";
import { CostFilterRows } from "./CostGraphConfigModal.js";
import { formatMoney } from "./transform.js";
import { Modal } from "../components/Modal.js";
import type { CostsClient } from "./types.js";

const inputClass =
  "w-full rounded-lg border border-border bg-surface-sunken px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500";
const labelClass = "block text-xs font-medium text-on-surface-secondary mb-1";

/** How many recent events the section shows. */
const EVENTS_SHOWN = 20;

function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "week of Aug 3–Aug 9" / "Aug 9" — the current window, compactly. */
function windowLabel(event: CostAlertEvent): string {
  if (event.windowFrom === event.windowTo) return formatDay(event.windowTo);
  return `${formatDay(event.windowFrom)}–${formatDay(event.windowTo)}`;
}

/** One line describing what an alert watches, for the list row. */
function describeScope(alert: CostAlert): string {
  const parts: string[] = [];
  parts.push(
    alert.groupBy === null
      ? "one total"
      : `each ${(COST_DIMENSION_LABELS[alert.groupBy] ?? alert.groupBy).toLowerCase()}${
          alert.groupBy === "tag" && alert.groupByTagKey ? ` (${alert.groupByTagKey})` : ""
        }`,
  );
  parts.push(
    alert.filters.length === 0
      ? "all spend"
      : `${alert.filters.length} filter${alert.filters.length === 1 ? "" : "s"}`,
  );
  return parts.join(" · ");
}

/** "≥ 25% and ≥ $100 up" — the firing condition, compactly. */
function describeThreshold(alert: CostAlert): string {
  const parts: string[] = [];
  if (alert.thresholdPercent !== null) parts.push(`≥ ${alert.thresholdPercent}%`);
  if (alert.thresholdAmountCents !== null) {
    parts.push(`≥ ${formatMoney(alert.thresholdAmountCents / 100, "USD")}`);
  }
  const direction =
    alert.direction === "both" ? "either way" : alert.direction === "increase" ? "up" : "down";
  return `${parts.join(" and ")} ${direction}`;
}

const CADENCE_BADGE: Record<CostChangeCadence, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

export interface CostChangeAlertsSectionProps {
  client: CostsClient;
}

/**
 * Change-based cost alerts — "tell me when spend on this scope moves more
 * than X% (or $Y) versus the prior period". The third alert family on this
 * panel, deliberately distinct from the two around it: budgets (above) watch
 * an absolute monthly total, anomaly detection (also above) watches
 * statistical outliers with no configuration, and these watch a *configured
 * relative change* on a chosen scope and cadence.
 */
export function CostChangeAlertsSection({ client }: CostChangeAlertsSectionProps) {
  const [alerts, setAlerts] = useState<CostAlert[] | null>(null);
  const [events, setEvents] = useState<CostAlertEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ alert: CostAlert | null } | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const canWrite = Boolean(
    client.createCostAlert && client.updateCostAlert && client.deleteCostAlert,
  );

  useEffect(() => {
    const listAlerts = client.listCostAlerts;
    if (!listAlerts) return;
    let cancelled = false;
    // Awaited inside try/catch rather than chained off .catch(): a host's
    // implementation may throw synchronously (desktop's requires cloud mode),
    // and a synchronous throw escapes a promise chain entirely.
    void (async () => {
      try {
        const rows = await listAlerts();
        if (!cancelled) {
          setAlerts(rows);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
      // The events feed is decoration on the section, not its point — a
      // failure there degrades to "no recent events" rather than an error.
      try {
        const rows = (await client.listCostAlertEvents?.({ limit: EVENTS_SHOWN })) ?? [];
        if (!cancelled) setEvents(rows);
      } catch {
        if (!cancelled) setEvents([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, reloadNonce]);

  if (!client.listCostAlerts) return null;

  const refresh = () => setReloadNonce((n) => n + 1);

  const save = async (input: CostAlertInput) => {
    if (editing?.alert) {
      await client.updateCostAlert?.(editing.alert.id, input);
    } else {
      await client.createCostAlert?.(input);
    }
    refresh();
  };

  const remove = async (alert: CostAlert) => {
    if (!window.confirm(`Delete the cost alert "${alert.name}"? Its fired events go with it.`)) {
      return;
    }
    try {
      await client.deleteCostAlert?.(alert.id);
      refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-on-surface">Change alerts</h2>
        {canWrite && (
          <button
            type="button"
            onClick={() => setEditing({ alert: null })}
            className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            New alert
          </button>
        )}
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          Couldn&rsquo;t load change alerts — {error}
        </div>
      )}

      {alerts === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Loading change alerts…
        </p>
      )}

      {alerts?.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          No change alerts yet. A change alert fires when spend on a scope you choose moves more
          than a threshold you choose versus the prior period — unlike budgets (an absolute monthly
          total) and anomaly detection (statistical outliers against a learned baseline).
        </p>
      )}

      {alerts !== null && alerts.length > 0 && (
        <ul className="divide-y divide-border/50 rounded-xl border border-border">
          {alerts.map((alert) => (
            <li key={alert.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-on-surface">{alert.name}</span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wide text-on-surface-faint">
                    {CADENCE_BADGE[alert.cadence]}
                  </span>
                  {!alert.enabled && (
                    <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
                      Paused
                    </span>
                  )}
                </div>
                <p className="text-xs text-on-surface-faint">
                  {describeThreshold(alert)} · {describeScope(alert)} ·{" "}
                  {COST_CHANGE_CADENCE_DESCRIPTIONS[alert.cadence].toLowerCase()}
                </p>
              </div>
              <span className="whitespace-nowrap text-xs text-on-surface-faint">
                {alert.lastFiredAt ? `Last fired ${formatWhen(alert.lastFiredAt)}` : "Never fired"}
              </span>
              {canWrite && (
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing({ alert })}
                    className="text-xs text-info hover:text-info-strong"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(alert)}
                    className="text-xs text-on-surface-faint hover:text-danger"
                  >
                    Delete
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {events !== null && events.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-on-surface-faint">
            Recent firings
          </h3>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-on-surface-faint">
                  <th className="px-3 py-2 font-medium">When</th>
                  <th className="px-3 py-2 font-medium">Alert</th>
                  <th className="px-3 py-2 font-medium">Window</th>
                  <th className="px-3 py-2 font-medium text-right">Previous → current</th>
                  <th className="px-3 py-2 font-medium text-right">Change</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {events.map((event) => (
                  <tr key={event.id} className="text-on-surface-secondary">
                    <td className="whitespace-nowrap px-3 py-2">{formatWhen(event.firedAt)}</td>
                    <td className="px-3 py-2">
                      <span className="text-on-surface">{event.alertName}</span>
                      {event.groupKey !== "" && (
                        <span className="ml-1 text-xs text-on-surface-faint">
                          · {event.groupKey}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">{windowLabel(event)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {formatMoney(event.previousAmountCents / 100, event.currency)}{" "}
                      <span className="text-on-surface-faint">→</span>{" "}
                      <span className="font-medium text-on-surface">
                        {formatMoney(event.currentAmountCents / 100, event.currency)}
                      </span>
                    </td>
                    <td
                      className={`whitespace-nowrap px-3 py-2 text-right ${
                        event.direction === "increase" ? "text-danger" : "text-success"
                      }`}
                    >
                      {costAlertEventDeltaLabel(event)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <CostChangeAlertConfigModal
          initialInput={editing.alert ? alertToInput(editing.alert) : DEFAULT_COST_ALERT_INPUT}
          client={client}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/** The stored alert, back into the create/update shape the modal edits. */
export function alertToInput(alert: CostAlert): CostAlertInput {
  return {
    name: alert.name,
    filters: alert.filters,
    groupBy: alert.groupBy,
    ...(alert.groupByTagKey ? { groupByTagKey: alert.groupByTagKey } : {}),
    cadence: alert.cadence,
    thresholdPercent: alert.thresholdPercent,
    thresholdAmountCents: alert.thresholdAmountCents,
    direction: alert.direction,
    enabled: alert.enabled,
  };
}

export interface CostChangeAlertConfigModalProps {
  initialInput: CostAlertInput;
  client: CostsClient;
  onSave: (input: CostAlertInput) => Promise<void> | void;
  onClose: () => void;
}

/**
 * Create/edit one change alert. Validates locally against the same schema the
 * API enforces and delegates persistence to the parent, like the budget
 * modal. The `client` doubles as the `CostApi` the filter rows need for
 * dimension pickers.
 */
export function CostChangeAlertConfigModal({
  initialInput,
  client,
  onSave,
  onClose,
}: CostChangeAlertConfigModalProps) {
  const uid = useId();
  const [input, setInput] = useState<CostAlertInput>(initialInput);
  const [percentText, setPercentText] = useState(
    initialInput.thresholdPercent === null ? "" : String(initialInput.thresholdPercent),
  );
  const [amountText, setAmountText] = useState(
    initialInput.thresholdAmountCents === null
      ? ""
      : (initialInput.thresholdAmountCents / 100).toString(),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<CostAlertInput>) =>
    setInput((prev) => ({ ...prev, ...patch }) as CostAlertInput);

  const save = async () => {
    const percent = percentText.trim() === "" ? null : Number(percentText);
    const amount = amountText.trim() === "" ? null : Number(amountText);
    if (percent !== null && (!Number.isFinite(percent) || percent <= 0)) {
      setError("The percent threshold must be a positive number (or empty).");
      return;
    }
    if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
      setError("The amount threshold must be a positive number (or empty).");
      return;
    }
    if (percent === null && amount === null) {
      setError("Set a percent threshold, an amount threshold, or both.");
      return;
    }
    const cleaned: CostAlertInput = {
      ...input,
      thresholdPercent: percent === null ? null : Math.round(percent),
      thresholdAmountCents: amount === null ? null : Math.round(amount * 100),
      filters: input.filters.filter((f) => f.values.length > 0),
    };
    const parsed = costAlertInputSchema.safeParse(cleaned);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid cost alert");
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
    <Modal onClose={onClose} ariaLabel="Change alert">
      <div className="w-[32rem] max-w-[90vw] rounded-2xl border border-border bg-surface-raised p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-on-surface mb-1">Change alert</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          Fires when spend on this scope moves past the threshold versus the prior period. Each
          period fires at most once per watched group.
        </p>

        <div className="space-y-4">
          <div>
            <label htmlFor={`${uid}-name`} className={labelClass}>
              Name
            </label>
            <input
              id={`${uid}-name`}
              className={inputClass}
              maxLength={COST_ALERT_LIMITS.maxNameLength}
              placeholder="e.g. Weekly AWS movement"
              value={input.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${uid}-cadence`} className={labelClass}>
                Cadence
              </label>
              <select
                id={`${uid}-cadence`}
                className={inputClass}
                value={input.cadence}
                onChange={(e) => set({ cadence: e.target.value as CostChangeCadence })}
              >
                {COST_CHANGE_CADENCES.map((cadence) => (
                  <option key={cadence} value={cadence}>
                    {COST_CHANGE_CADENCE_LABELS[cadence]}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-on-surface-faint">
                {COST_CHANGE_CADENCE_DESCRIPTIONS[input.cadence]}.
              </p>
            </div>
            <div>
              <label htmlFor={`${uid}-direction`} className={labelClass}>
                Direction
              </label>
              <select
                id={`${uid}-direction`}
                className={inputClass}
                value={input.direction}
                onChange={(e) => set({ direction: e.target.value as CostChangeDirection })}
              >
                {COST_CHANGE_DIRECTIONS.map((direction) => (
                  <option key={direction} value={direction}>
                    {COST_CHANGE_DIRECTION_LABELS[direction]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={`${uid}-percent`} className={labelClass}>
                Moves at least (%)
              </label>
              <input
                id={`${uid}-percent`}
                type="number"
                min={COST_ALERT_LIMITS.minPercent}
                max={COST_ALERT_LIMITS.maxPercent}
                step={1}
                className={inputClass}
                placeholder="e.g. 25"
                value={percentText}
                onChange={(e) => setPercentText(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor={`${uid}-amount`} className={labelClass}>
                And at least (amount)
              </label>
              <input
                id={`${uid}-amount`}
                type="number"
                min={0}
                step="0.01"
                className={inputClass}
                placeholder="e.g. 100"
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
              />
            </div>
          </div>
          <p className="text-[11px] text-on-surface-faint">
            Set one or both. When both are set the change must clear <em>both</em> bars, so a 50%
            jump on $2 of spend stays quiet. New spend with no prior baseline counts as an infinite
            percent change — an amount floor is what keeps tiny new groups from firing.
          </p>

          <div>
            <label htmlFor={`${uid}-groupby`} className={labelClass}>
              Watch
            </label>
            <select
              id={`${uid}-groupby`}
              className={inputClass}
              value={input.groupBy ?? "none"}
              onChange={(e) =>
                set({
                  groupBy: e.target.value === "none" ? null : (e.target.value as CostDimensionId),
                })
              }
            >
              <option value="none">The scope&rsquo;s one total</option>
              {COST_DIMENSIONS.map((dimension) => (
                <option key={dimension} value={dimension}>
                  Each {COST_DIMENSION_LABELS[dimension].toLowerCase()} separately
                </option>
              ))}
            </select>
            {input.groupBy === "tag" && (
              <input
                aria-label="Tag key"
                className={`${inputClass} mt-2`}
                placeholder="Tag key, e.g. team"
                value={input.groupByTagKey ?? ""}
                onChange={(e) => set({ groupByTagKey: e.target.value })}
              />
            )}
            <p className="mt-1 text-[11px] text-on-surface-faint">
              Watching a dimension compares each group against its own prior window — each offending
              group fires its own event.
            </p>
          </div>

          <div role="group" aria-labelledby={`${uid}-scope-label`}>
            <span id={`${uid}-scope-label`} className={labelClass}>
              Scope (all spend when empty)
            </span>
            <CostFilterRows
              filters={input.filters as CostFilter[]}
              onChange={(filters) => set({ filters })}
              api={client}
            />
          </div>

          <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
            <input
              type="checkbox"
              checked={input.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            Enabled
          </label>

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
              disabled={saving}
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
