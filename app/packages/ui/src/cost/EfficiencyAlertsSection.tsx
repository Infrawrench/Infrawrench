import {
  COST_EFFICIENCY_LIMITS,
  DEFAULT_COST_EFFICIENCY_SETTINGS,
  EFFICIENCY_ALERT_KIND_LABELS,
} from "@infrawrench/client-core";
import { useEffect, useId, useState } from "react";
import { T, Var, useGT } from "gt-react";

import { parseNumericInputValue } from "../form-values.js";
import { useDataString } from "../i18n/data-strings.js";
import { formatMoney } from "./transform.js";
import type { CostEfficiencySettings } from "./config.js";
import type { CostsClient, EfficiencyAlertEvent, EfficiencyAlertKind } from "./types.js";

/** Rows shown before the list is cut off. */
const EVENTS_SHOWN = 25;

function toDollars(cents: number): number {
  return Math.round(cents) / 100;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const KIND_TONE: Record<EfficiencyAlertKind, string> = {
  commitment_expiry: "text-warning",
  commitment_idle: "text-info",
  unit_cost_regression: "text-danger",
};

/**
 * A one-line summary of what a firing said, per kind.
 *
 * The `detail` bag is display-only and this is the only thing that reads it,
 * which is exactly why the wire type keeps it free-form: three detectors with
 * genuinely different facts share one list without three wire types or a
 * discriminated union nobody else needs.
 */
function describeEvent(
  event: EfficiencyAlertEvent,
  gt: ReturnType<typeof useGT>,
  gtData: ReturnType<typeof useDataString>,
): string {
  const d = event.detail;
  switch (event.kind) {
    case "commitment_expiry": {
      const horizon = typeof d["horizonDays"] === "number" ? d["horizonDays"] : null;
      const end = typeof d["termEndDay"] === "string" ? d["termEndDay"] : "";
      const when =
        horizon === 0
          ? gt("expired {end}", { end })
          : gt("ends {end} ({horizon}-day notice)", { end, horizon });
      const exposure =
        event.amount !== null
          ? gt(" · at least {amount}/month reverts to on-demand", {
              amount: formatMoney(event.amount, event.currency ?? "USD"),
            })
          : "";
      return `${when}${exposure}`;
    }
    case "commitment_idle": {
      const percent = typeof d["utilizationPercent"] === "number" ? d["utilizationPercent"] : null;
      const from = typeof d["windowFrom"] === "string" ? d["windowFrom"] : "";
      const to = typeof d["windowTo"] === "string" ? d["windowTo"] : "";
      const wasted =
        event.amount !== null
          ? gt("{amount} unused", { amount: formatMoney(event.amount, event.currency ?? "USD") })
          : gt("unused");
      return gt("{percent}% used over {from}–{to} · {wasted}", {
        percent: percent ?? "?",
        from,
        to,
        wasted,
      });
    }
    case "unit_cost_regression": {
      const percent = typeof d["changePercent"] === "number" ? d["changePercent"] : null;
      const unit = typeof d["unit"] === "string" && d["unit"] ? gtData(d["unit"]) : gt("unit");
      const before = typeof d["previousUnitCost"] === "number" ? d["previousUnitCost"] : null;
      const after = typeof d["currentUnitCost"] === "number" ? d["currentUnitCost"] : null;
      const move =
        before !== null && after !== null
          ? gt(" ({before} → {after})", {
              before: formatMoney(before, event.currency ?? "USD"),
              after: formatMoney(after, event.currency ?? "USD"),
            })
          : "";
      return gt("cost per {unit} up {percent}%{move}", {
        unit,
        percent: percent ?? "?",
        move,
      });
    }
    default:
      // A row written by a newer build naming a fourth detector. Rendering the
      // subject alone is better than dropping the row from the list.
      return "";
  }
}

export interface EfficiencyAlertsSectionProps {
  client: CostsClient;
}

/**
 * The three slow-lane cost alerts: commitments about to lapse, commitments
 * nobody is using, and business metrics whose cost per unit rose.
 *
 * Kept apart from the anomaly and change-alert sections above it because it is
 * a different *kind* of reading. Those two answer "did something happen
 * yesterday"; these three answer "is something quietly wrong" — the reader
 * acts on them within a week rather than within an hour, and every one of them
 * is derived from a fact (a term end, an obligation, a volume) that no spend
 * total contains.
 *
 * Renders nothing at all when the org has never fired one and the host cannot
 * edit the settings: an org with no commitments and no business metrics has
 * nothing to say here and an empty panel would just be furniture.
 */
export function EfficiencyAlertsSection({ client }: EfficiencyAlertsSectionProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [events, setEvents] = useState<EfficiencyAlertEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tuning, setTuning] = useState(false);

  useEffect(() => {
    const list = client.listEfficiencyAlerts;
    if (!list) return;
    let cancelled = false;
    // Awaited inside try/catch rather than chained off .catch(): a host's
    // implementation may throw *synchronously* (desktop's requires cloud mode
    // and throws when there is no active org), and a synchronous throw escapes
    // a promise chain entirely.
    void (async () => {
      try {
        const rows = await list({ limit: EVENTS_SHOWN });
        if (!cancelled) {
          setEvents(rows);
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

  if (!client.listEfficiencyAlerts) return null;
  const canTune = Boolean(client.getEfficiencyAlertSettings);
  // Nothing has ever fired and there is nothing to configure — say nothing.
  if (!canTune && error === null && events !== null && events.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface-secondary">
            {gt("Commitment & unit-cost alerts")}
          </h2>
          <p className="text-xs text-on-surface-faint">
            {gt(
              "Three things the cost data already knows and no spend total can show: a commitment about to lapse, a commitment nobody is using, and cost per unit going the wrong way.",
            )}
          </p>
        </div>
        {canTune && (
          <button
            type="button"
            onClick={() => setTuning((v) => !v)}
            className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
          >
            {tuning ? gt("Hide settings") : gt("Tune alerts")}
          </button>
        )}
      </div>

      {tuning && <EfficiencyTuningPanel client={client} />}

      {error !== null && (
        <div role="alert" className="rounded-xl border border-border p-4 text-sm text-danger">
          <T>
            Couldn&rsquo;t load efficiency alerts — <Var>{error}</Var>
          </T>
        </div>
      )}

      {error === null && events === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading efficiency alerts…")}
        </p>
      )}

      {error === null && events !== null && events.length === 0 && (
        <p className="rounded-xl border border-border p-4 text-sm text-on-surface-faint">
          {gt(
            "Nothing has fired yet. Commitment alerts need at least one reservation, savings plan or committed-use discount; unit-cost regressions need a business metric with a fortnight of reported values on each side of the comparison.",
          )}
        </p>
      )}

      {events !== null && events.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {events.map((event) => (
            <li key={event.id} className="flex flex-col gap-0.5 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className={`text-[11px] font-medium ${KIND_TONE[event.kind] ?? ""}`}>
                  {gtData(EFFICIENCY_ALERT_KIND_LABELS[event.kind])}
                </span>
                <span className="truncate text-sm text-on-surface">{event.subject}</span>
                {event.accountName && (
                  <span className="shrink-0 text-[11px] text-on-surface-faint">
                    {event.accountName}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[11px] text-on-surface-faint">
                  {formatWhen(event.firedAt)}
                </span>
              </div>
              <p className="text-xs text-on-surface-secondary">
                {describeEvent(event, gt, gtData)}
              </p>
              {event.notifiedAt === null && (
                <p className="text-[11px] text-on-surface-faint">
                  {gt(
                    "Stored but not delivered — no routing rule matched, or quiet hours are holding it.",
                  )}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One labelled number input. Extracted because this panel has nine of them. */
function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1" htmlFor={id}>
      <span className="text-xs font-medium text-on-surface-secondary">{label}</span>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        step={step ?? 1}
        min={min}
        max={max}
        disabled={disabled}
        value={value}
        onChange={(e) => {
          // `Number("")` is 0 — clearing the box to retype would otherwise
          // store a threshold of zero. See `form-values.ts`.
          const next = parseNumericInputValue(e.target.value);
          if (next !== null) onChange(next);
        }}
        className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500 disabled:opacity-60"
      />
      <span className="text-[11px] text-on-surface-faint">{hint}</span>
    </label>
  );
}

/**
 * The per-org thresholds, edited in place. Read-only when the host omits
 * `updateEfficiencyAlertSettings` — a viewer without `costs:write` sees what
 * the detectors are tuned to without controls that would fail on save.
 *
 * The bounds mirror the ones the API enforces, so a value the server would
 * reject is caught before the round trip; the server is still the authority.
 */
function EfficiencyTuningPanel({ client }: { client: CostsClient }) {
  const gt = useGT();
  const uid = useId();
  const [draft, setDraft] = useState<CostEfficiencySettings | null>(null);
  const [saved, setSaved] = useState<CostEfficiencySettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  /** The horizon list as typed. Kept as text so "60, 30," is editable. */
  const [horizonText, setHorizonText] = useState("");

  const canEdit = Boolean(client.updateEfficiencyAlertSettings);

  useEffect(() => {
    const load = client.getEfficiencyAlertSettings;
    if (!load) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await load();
        if (!cancelled) {
          setDraft(settings);
          setSaved(settings);
          setHorizonText(settings.commitmentExpiryHorizonDays.join(", "));
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

  function validate(next: CostEfficiencySettings): string | null {
    const L = COST_EFFICIENCY_LIMITS;
    if (next.commitmentExpiryHorizonDays.length === 0) {
      return gt("Give at least one expiry horizon, or turn commitment expiry alerts off.");
    }
    if (next.commitmentExpiryHorizonDays.length > L.maxExpiryHorizons) {
      return gt("At most {max} horizons — past that one commitment becomes its own digest.", {
        max: L.maxExpiryHorizons,
      });
    }
    if (
      next.commitmentExpiryHorizonDays.some(
        (h) => h < L.minExpiryHorizonDays || h > L.maxExpiryHorizonDays,
      )
    ) {
      return gt("Each horizon must be between {min} and {max} days.", {
        min: L.minExpiryHorizonDays,
        max: L.maxExpiryHorizonDays,
      });
    }
    if (next.commitmentIdleMinMeasuredDays > next.commitmentIdleWindowDays) {
      return gt("The idle window can't require more days of data than it contains.");
    }
    if (next.unitCostMinReportedDays > next.unitCostWindowDays) {
      return gt("Each unit-cost window can't require more reported days than it contains.");
    }
    return null;
  }

  async function save() {
    const update = client.updateEfficiencyAlertSettings;
    if (!update || !draft) return;
    const invalid = validate(draft);
    if (invalid) {
      setSaveError(invalid);
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      const next = await update(draft);
      setDraft(next);
      setSaved(next);
      setHorizonText(next.commitmentExpiryHorizonDays.join(", "));
      setJustSaved(true);
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loadError !== null) {
    return (
      <div role="alert" className="rounded-xl border border-border p-4 text-sm text-danger">
        <T>
          Couldn&rsquo;t load alert settings — <Var>{loadError}</Var>
        </T>
      </div>
    );
  }

  if (!draft || !saved) {
    return (
      <p role="status" className="text-sm text-on-surface-faint">
        {gt("Loading alert settings…")}
      </p>
    );
  }

  const dirty = (Object.keys(draft) as Array<keyof CostEfficiencySettings>).some((key) =>
    key === "commitmentExpiryHorizonDays"
      ? draft.commitmentExpiryHorizonDays.join(",") !== saved.commitmentExpiryHorizonDays.join(",")
      : draft[key] !== saved[key],
  );

  function set(patch: Partial<CostEfficiencySettings>) {
    setJustSaved(false);
    setSaveError(null);
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  const disabled = !canEdit || busy;
  const D = DEFAULT_COST_EFFICIENCY_SETTINGS;
  const L = COST_EFFICIENCY_LIMITS;

  return (
    <div className="flex flex-col gap-5 rounded-xl border border-border bg-surface-sunken p-4">
      <p className="text-xs text-on-surface-faint">
        {gt(
          "Changes apply on the next evaluation pass, which runs after each cost collection. Alerts already fired are not re-judged — widening the horizon list warns about future crossings, not past ones.",
        )}
      </p>

      {/* --- Commitment expiry --- */}
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-sm text-on-surface">
          <input
            type="checkbox"
            disabled={disabled}
            checked={draft.commitmentExpiryEnabled}
            onChange={(e) => set({ commitmentExpiryEnabled: e.target.checked })}
          />
          <span className="font-medium">{gt("Commitment expiry")}</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor={`${uid}-horizons`}>
            <span className="text-xs font-medium text-on-surface-secondary">
              {gt("Horizons (days of notice)")}
            </span>
            <input
              id={`${uid}-horizons`}
              type="text"
              inputMode="numeric"
              disabled={disabled}
              value={horizonText}
              onChange={(e) => {
                setHorizonText(e.target.value);
                const parsed = e.target.value
                  .split(",")
                  .map((part) => parseNumericInputValue(part))
                  .filter((n): n is number => n !== null && Number.isInteger(n) && n > 0);
                set({ commitmentExpiryHorizonDays: [...new Set(parsed)].sort((a, b) => b - a) });
              }}
              className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500 disabled:opacity-60"
            />
            <span className="text-[11px] text-on-surface-faint">
              <T>
                Comma separated. Each fires once per commitment per term, and a commitment fires at
                the smallest horizon it has reached — so an account connected 30 days out gets one
                alert, not two. Default <Var>{D.commitmentExpiryHorizonDays.join(", ")}</Var>.
              </T>
            </span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-on-surface-secondary">
              {gt("Already-expired commitments")}
            </span>
            <label className="flex items-center gap-2 text-sm text-on-surface">
              <input
                type="checkbox"
                disabled={disabled}
                checked={draft.commitmentExpiryAlertOnExpired}
                onChange={(e) => set({ commitmentExpiryAlertOnExpired: e.target.checked })}
              />
              <span>{gt("Alert once about ones that already lapsed")}</span>
            </label>
            <span className="text-[11px] text-on-surface-faint">
              {gt(
                "A commitment that ended before we ever collected it cannot have crossed a horizon, so nothing else would ever mention it. Bounded to the last 90 days. Default on.",
              )}
            </span>
          </label>
        </div>
      </div>

      {/* --- Idle commitments --- */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <label className="flex items-center gap-2 text-sm text-on-surface">
          <input
            type="checkbox"
            disabled={disabled}
            checked={draft.commitmentIdleEnabled}
            onChange={(e) => set({ commitmentIdleEnabled: e.target.checked })}
          />
          <span className="font-medium">{gt("Idle commitments")}</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField
            id={`${uid}-idle-threshold`}
            label={gt("Utilization under (%)")}
            hint={gt(
              "Aggregated over the whole window, never sampled per day — a weekday-only workload reads about 71% and stays quiet. Default {value}%.",
              { value: D.commitmentIdleThresholdPercent },
            )}
            value={draft.commitmentIdleThresholdPercent}
            min={L.minIdleThresholdPercent}
            max={L.maxIdleThresholdPercent}
            disabled={disabled}
            onChange={(v) => set({ commitmentIdleThresholdPercent: v })}
          />
          <NumberField
            id={`${uid}-idle-window`}
            label={gt("Window (days)")}
            hint={gt("Trailing days measured. Default {value}.", {
              value: D.commitmentIdleWindowDays,
            })}
            value={draft.commitmentIdleWindowDays}
            min={L.minIdleWindowDays}
            max={L.maxIdleWindowDays}
            disabled={disabled}
            onChange={(v) => set({ commitmentIdleWindowDays: v })}
          />
          <NumberField
            id={`${uid}-idle-measured`}
            label={gt("Least days with data")}
            hint={gt(
              "Window days that must carry cost rows before anything is judged. A commitment whose utilization can't be measured at all never alerts, whatever this says. Default {value}.",
              { value: D.commitmentIdleMinMeasuredDays },
            )}
            value={draft.commitmentIdleMinMeasuredDays}
            min={L.minIdleMinMeasuredDays}
            max={L.maxIdleMinMeasuredDays}
            disabled={disabled}
            onChange={(v) => set({ commitmentIdleMinMeasuredDays: v })}
          />
          <NumberField
            id={`${uid}-idle-waste`}
            label={gt("Least waste (USD)")}
            hint={gt("The floor is on the money, not the percentage. Default {value}.", {
              value: formatMoney(toDollars(D.commitmentIdleMinWasteCents), "USD"),
            })}
            value={toDollars(draft.commitmentIdleMinWasteCents)}
            min={toDollars(L.minIdleWasteCents)}
            max={toDollars(L.maxIdleWasteCents)}
            disabled={disabled}
            onChange={(v) => set({ commitmentIdleMinWasteCents: Math.round(v * 100) })}
          />
        </div>
      </div>

      {/* --- Unit-cost regression --- */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <label className="flex items-center gap-2 text-sm text-on-surface">
          <input
            type="checkbox"
            disabled={disabled}
            checked={draft.unitCostRegressionEnabled}
            onChange={(e) => set({ unitCostRegressionEnabled: e.target.checked })}
          />
          <span className="font-medium">{gt("Unit-cost regressions")}</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumberField
            id={`${uid}-unit-threshold`}
            label={gt("Unit cost up by (%)")}
            hint={gt("Versus the prior window. Default {value}%.", {
              value: D.unitCostThresholdPercent,
            })}
            value={draft.unitCostThresholdPercent}
            min={L.minUnitCostThresholdPercent}
            max={L.maxUnitCostThresholdPercent}
            disabled={disabled}
            onChange={(v) => set({ unitCostThresholdPercent: v })}
          />
          <NumberField
            id={`${uid}-unit-window`}
            label={gt("Each window (days)")}
            hint={gt(
              "Two adjacent windows of this length are compared. Default {value} — two whole weekly cycles a side.",
              { value: D.unitCostWindowDays },
            )}
            value={draft.unitCostWindowDays}
            min={L.minUnitCostWindowDays}
            max={L.maxUnitCostWindowDays}
            disabled={disabled}
            onChange={(v) => set({ unitCostWindowDays: v })}
          />
          <NumberField
            id={`${uid}-unit-reported`}
            label={gt("Least reported days")}
            hint={gt(
              "Required in each window. A day with no reported metric value is a gap, not a zero: it counts on neither side, and a window below this bar produces no comparison at all. Default {value}.",
              { value: D.unitCostMinReportedDays },
            )}
            value={draft.unitCostMinReportedDays}
            min={L.minUnitCostReportedDays}
            max={L.maxUnitCostReportedDays}
            disabled={disabled}
            onChange={(v) => set({ unitCostMinReportedDays: v })}
          />
          <NumberField
            id={`${uid}-unit-spend`}
            label={gt("Least window spend (USD)")}
            hint={gt(
              "A scope spending less than this can't move a unit cost readably. Default {value}.",
              {
                value: formatMoney(toDollars(D.unitCostMinSpendCents), "USD"),
              },
            )}
            value={toDollars(draft.unitCostMinSpendCents)}
            min={toDollars(L.minUnitCostSpendCents)}
            max={toDollars(L.maxUnitCostSpendCents)}
            disabled={disabled}
            onChange={(v) => set({ unitCostMinSpendCents: Math.round(v * 100) })}
          />
        </div>
      </div>

      {saveError !== null && (
        <div role="alert" className="text-sm text-danger">
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
            {busy ? gt("Saving…") : gt("Save")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              set({ ...DEFAULT_COST_EFFICIENCY_SETTINGS });
              setHorizonText(D.commitmentExpiryHorizonDays.join(", "));
            }}
            className="text-xs text-on-surface-faint underline hover:text-on-surface-secondary disabled:opacity-50"
          >
            {gt("Reset to defaults")}
          </button>
          {justSaved && !dirty && (
            <span role="status" className="text-xs text-on-surface-faint">
              {gt("Saved.")}
            </span>
          )}
        </div>
      ) : (
        <p className="text-xs text-on-surface-faint">
          {gt("You don't have permission to change these.")}
        </p>
      )}
    </div>
  );
}
