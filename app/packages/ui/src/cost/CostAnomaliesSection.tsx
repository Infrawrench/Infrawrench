import {
  COST_ANOMALY_DIMENSION_LABELS,
  COST_ANOMALY_LIMITS,
  COST_ANOMALY_SMS_MODES,
  COST_ANOMALY_SMS_MODE_LABELS,
  DEFAULT_COST_ANOMALY_SETTINGS,
  costAnomalyDeltaPercent,
} from "@infrawrench/client-core";
import { useEffect, useId, useState } from "react";

import { formatMoney } from "./transform.js";
import type { CostAnomalySettings, CostAnomalySettingsView, CostAnomalySmsMode } from "./config.js";
import type { CostAnomaly, CostsClient } from "./types.js";

/** How far back the section looks, in days. */
const WINDOW_DAYS = 30;

function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export interface CostAnomaliesSectionProps {
  client: CostsClient;
}

/**
 * Recent spend anomalies — days where a provider's or service's spend cleared
 * the trailing-baseline threshold, and days where one started spending with no
 * history at all. Detection runs server-side after each cost collection; the
 * only thing configurable from here is what counts as anomalous, which the
 * tuning panel edits when the host wires the settings calls.
 */
export function CostAnomaliesSection({ client }: CostAnomaliesSectionProps) {
  const [anomalies, setAnomalies] = useState<CostAnomaly[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tuning, setTuning] = useState(false);

  useEffect(() => {
    const listAnomalies = client.listAnomalies;
    if (!listAnomalies) return;
    let cancelled = false;
    // Awaited inside try/catch rather than chained off .catch(): a host's
    // implementation may throw *synchronously* (desktop's requires cloud mode
    // and throws when there is no active org), and a synchronous throw escapes
    // a promise chain entirely — straight past .catch() and into the nearest
    // error boundary, taking the app down.
    void (async () => {
      try {
        const rows = await listAnomalies(WINDOW_DAYS);
        if (!cancelled) {
          setAnomalies(rows);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (!client.listAnomalies) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-on-surface">Anomalies</h2>
        {client.getAnomalySettings && (
          <button
            type="button"
            onClick={() => setTuning((open) => !open)}
            aria-expanded={tuning}
            className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            {tuning ? "Hide tuning" : "Tune detection"}
          </button>
        )}
      </div>

      {tuning && client.getAnomalySettings && <AnomalyTuningPanel client={client} />}

      {error !== null && (
        <div role="alert" className="text-sm text-red-500">
          Couldn&rsquo;t load anomalies — {error}
        </div>
      )}

      {anomalies === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Loading anomalies…
        </p>
      )}

      {anomalies?.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          No spend anomalies in the last {WINDOW_DAYS} days. Detection compares each day&rsquo;s
          spend per provider and per service against its trailing 28-day baseline, flags
          statistically unusual spikes, and separately flags anything that starts spending with no
          history at all.
        </p>
      )}

      {anomalies !== null && anomalies.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-on-surface-faint">
                <th className="px-3 py-2 font-medium">Day</th>
                <th className="px-3 py-2 font-medium">What</th>
                <th className="px-3 py-2 font-medium text-right">Spend</th>
                <th className="px-3 py-2 font-medium text-right">Baseline / day</th>
                <th className="px-3 py-2 font-medium text-right">Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {anomalies.map((a) => {
                const delta = costAnomalyDeltaPercent(a);
                const isNew = a.kind === "new_source";
                return (
                  <tr key={a.id} className="text-on-surface-secondary">
                    <td className="whitespace-nowrap px-3 py-2">{formatDay(a.day)}</td>
                    <td className="px-3 py-2">
                      <span className="text-on-surface">{a.dimensionKey}</span>{" "}
                      <span className="text-xs text-on-surface-faint">
                        {COST_ANOMALY_DIMENSION_LABELS[a.dimension]}
                      </span>
                      {isNew && (
                        <span className="ml-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-500">
                          New source
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-medium text-on-surface">
                      {formatMoney(a.actualCents / 100, a.currency)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {isNew ? (
                        <span className="text-on-surface-faint">none</span>
                      ) : (
                        formatMoney(a.baselineCents / 100, a.currency)
                      )}
                    </td>
                    <td
                      className={`whitespace-nowrap px-3 py-2 text-right ${
                        isNew ? "text-amber-500" : "text-red-500"
                      }`}
                    >
                      {delta ?? "new"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Whole dollars from cents, for the money inputs. */
function toDollars(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * The per-org thresholds, edited in place. Read-only when the host omits
 * `updateAnomalySettings` — a viewer without `costs:write` sees what detection
 * is tuned to without controls that would fail on save.
 *
 * The bounds mirror the ones the API enforces, so a value the server would
 * reject is caught before the round trip; the server is still the authority.
 */
function AnomalyTuningPanel({ client }: { client: CostsClient }) {
  const uid = useId();
  const [draft, setDraft] = useState<CostAnomalySettingsView | null>(null);
  const [saved, setSaved] = useState<CostAnomalySettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const canEdit = Boolean(client.updateAnomalySettings);

  useEffect(() => {
    const load = client.getAnomalySettings;
    if (!load) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await load();
        if (!cancelled) {
          setDraft(settings);
          setSaved(settings);
          setLoadError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  function validate(next: CostAnomalySettings): string | null {
    const L = COST_ANOMALY_LIMITS;
    if (!Number.isFinite(next.sigmas) || next.sigmas < L.sigmasMin || next.sigmas > L.sigmasMax) {
      return `Sensitivity must be between ${L.sigmasMin} and ${L.sigmasMax} standard deviations.`;
    }
    if (next.minDeltaCents < L.minDeltaCentsMin || next.minDeltaCents > L.minDeltaCentsMax) {
      return `The spike floor must be between ${formatMoney(toDollars(L.minDeltaCentsMin), "USD")} and ${formatMoney(toDollars(L.minDeltaCentsMax), "USD")}.`;
    }
    if (
      next.newSourceMinCents < L.newSourceMinCentsMin ||
      next.newSourceMinCents > L.newSourceMinCentsMax
    ) {
      return `The new-source floor must be between ${formatMoney(toDollars(L.newSourceMinCentsMin), "USD")} and ${formatMoney(toDollars(L.newSourceMinCentsMax), "USD")}.`;
    }
    return null;
  }

  async function save() {
    const update = client.updateAnomalySettings;
    if (!update || !draft) return;
    const invalid = validate(draft);
    if (invalid) {
      setSaveError(invalid);
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      // `smsConfigured` is derived server-side and the PUT body is strict, so
      // the stored fields are named out rather than the whole draft sent back.
      const next = await update({
        sigmas: draft.sigmas,
        minDeltaCents: draft.minDeltaCents,
        newSourceMinCents: draft.newSourceMinCents,
        smsAlerts: draft.smsAlerts,
      });
      setDraft(next);
      setSaved(next);
      setJustSaved(true);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loadError !== null) {
    return (
      <div role="alert" className="rounded-xl border border-border p-4 text-sm text-red-500">
        Couldn&rsquo;t load detection settings — {loadError}
      </div>
    );
  }

  if (!draft || !saved) {
    return (
      <p role="status" className="text-sm text-on-surface-faint">
        Loading detection settings…
      </p>
    );
  }

  const dirty =
    draft.sigmas !== saved.sigmas ||
    draft.minDeltaCents !== saved.minDeltaCents ||
    draft.newSourceMinCents !== saved.newSourceMinCents ||
    draft.smsAlerts !== saved.smsAlerts;

  /**
   * Asking for texts an org cannot receive. Twilio is configured on a page a
   * `costs:read` member cannot open, so this says what is missing instead of
   * accepting the setting and delivering nothing.
   */
  const smsUnreachable = draft.smsAlerts !== "off" && !draft.smsConfigured;

  function set(patch: Partial<CostAnomalySettings>) {
    setJustSaved(false);
    setSaveError(null);
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface-sunken p-4">
      <p className="text-xs text-on-surface-faint">
        What counts as anomalous for this organization. Changes apply on the next detection pass;
        anomalies already found are not re-judged. The 28-day baseline, the 7-day alert cooldown,
        and the minimum history a baseline needs are not adjustable.
      </p>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1" htmlFor={`${uid}-sigmas`}>
          <span className="text-xs font-medium text-on-surface-secondary">Sensitivity (σ)</span>
          <input
            id={`${uid}-sigmas`}
            type="number"
            inputMode="decimal"
            step={0.1}
            min={COST_ANOMALY_LIMITS.sigmasMin}
            max={COST_ANOMALY_LIMITS.sigmasMax}
            disabled={!canEdit || busy}
            value={draft.sigmas}
            onChange={(e) => set({ sigmas: Number(e.target.value) })}
            className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500 disabled:opacity-60"
          />
          <span className="text-[11px] text-on-surface-faint">
            Deviations above a key&rsquo;s own average before a day is a spike. Lower catches more,
            and alerts more. Default {DEFAULT_COST_ANOMALY_SETTINGS.sigmas}.
          </span>
        </label>

        <label className="flex flex-col gap-1" htmlFor={`${uid}-delta`}>
          <span className="text-xs font-medium text-on-surface-secondary">Spike floor (USD)</span>
          <input
            id={`${uid}-delta`}
            type="number"
            inputMode="decimal"
            step={1}
            min={toDollars(COST_ANOMALY_LIMITS.minDeltaCentsMin)}
            max={toDollars(COST_ANOMALY_LIMITS.minDeltaCentsMax)}
            disabled={!canEdit || busy}
            value={toDollars(draft.minDeltaCents)}
            onChange={(e) => set({ minDeltaCents: Math.round(Number(e.target.value) * 100) })}
            className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500 disabled:opacity-60"
          />
          <span className="text-[11px] text-on-surface-faint">
            A spike must also be this much above the baseline. Keeps penny-scale jumps quiet.
            Default {formatMoney(toDollars(DEFAULT_COST_ANOMALY_SETTINGS.minDeltaCents), "USD")}.
          </span>
        </label>

        <label className="flex flex-col gap-1" htmlFor={`${uid}-newsource`}>
          <span className="text-xs font-medium text-on-surface-secondary">
            New-source floor (USD)
          </span>
          <input
            id={`${uid}-newsource`}
            type="number"
            inputMode="decimal"
            step={1}
            min={toDollars(COST_ANOMALY_LIMITS.newSourceMinCentsMin)}
            max={toDollars(COST_ANOMALY_LIMITS.newSourceMinCentsMax)}
            disabled={!canEdit || busy}
            value={toDollars(draft.newSourceMinCents)}
            onChange={(e) => set({ newSourceMinCents: Math.round(Number(e.target.value) * 100) })}
            className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500 disabled:opacity-60"
          />
          <span className="text-[11px] text-on-surface-faint">
            A provider or service with no prior spend alerts once it bills this much in a day.
            Default {formatMoney(toDollars(DEFAULT_COST_ANOMALY_SETTINGS.newSourceMinCents), "USD")}
            .
          </span>
        </label>
      </div>

      <label className="flex flex-col gap-1" htmlFor={`${uid}-sms`}>
        <span className="text-xs font-medium text-on-surface-secondary">Text the on-call list</span>
        <select
          id={`${uid}-sms`}
          disabled={!canEdit || busy}
          value={draft.smsAlerts}
          onChange={(e) => set({ smsAlerts: e.target.value as CostAnomalySmsMode })}
          className="w-full rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500 disabled:opacity-60 sm:w-72"
        >
          {COST_ANOMALY_SMS_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {COST_ANOMALY_SMS_MODE_LABELS[mode]}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-on-surface-faint">
          Off by default. When on, each detection pass sends at most{" "}
          <strong className="font-medium">one</strong> SMS to your Twilio recipients summarizing
          what it alerted on — a day where thirty services jump is one text, not thirty — and no
          more than one every six hours. Push, Slack and Teams are unaffected and have their own
          toggles.
        </span>
      </label>

      {smsUnreachable && (
        <div role="alert" className="text-xs text-amber-500">
          This organization can&rsquo;t receive SMS yet. Anomaly texts need paging enabled with
          Twilio credentials and at least one recipient opted into SMS, under Settings &rarr;
          Notifications. Until then this setting is saved but nothing is sent.
        </div>
      )}

      {saveError !== null && (
        <div role="alert" className="text-sm text-red-500">
          {saveError}
        </div>
      )}

      {canEdit ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={busy || !dirty}
            onClick={() => void save()}
            className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => set({ ...DEFAULT_COST_ANOMALY_SETTINGS })}
            className="text-xs text-on-surface-faint underline hover:text-on-surface-secondary disabled:opacity-50"
          >
            Reset to defaults
          </button>
          {justSaved && !dirty && (
            <span role="status" className="text-xs text-on-surface-faint">
              Saved.
            </span>
          )}
        </div>
      ) : (
        <p className="text-xs text-on-surface-faint">
          You don&rsquo;t have permission to change these.
        </p>
      )}
    </div>
  );
}
