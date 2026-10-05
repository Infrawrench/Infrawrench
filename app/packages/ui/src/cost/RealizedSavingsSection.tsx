import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useGT } from "gt-react";
import {
  DEFAULT_REALIZED_SAVINGS_SETTINGS,
  REALIZED_SAVINGS_GROUPINGS,
  REALIZED_SAVINGS_LIMITS,
  SERIES_COLORS,
  describeSavingsShortfall,
  formatMoney,
  formatMonthlyEstimate,
  realizedSavingsRows,
  savingsEventInputError,
  type CostCentre,
  type RealizedSavingsBasis,
  type RealizedSavingsGrouping,
  type RealizedSavingsReport,
  type RealizedSavingsSettings,
  type SavingsEventInput,
  type SavingsEventKind,
  type SavingsEventResult,
  type SavingsEventSource,
  type SavingsEventStatus,
} from "@infrawrench/client-core";

import { Modal } from "../components/Modal.js";
import { labelClass, selectBaseClass, selectClass, tabClass } from "./form-styles.js";
import type { CostApi, CostsClient, SavingsResourceOption } from "./types.js";

type Gt = ReturnType<typeof useGT>;

/** Realized is the first categorical slot; projected is the same hue, outlined. */
const REALIZED_COLOR = SERIES_COLORS[0]!;

export function savingsKindLabel(gt: Gt, kind: SavingsEventKind): string {
  switch (kind) {
    case "rightsizing":
      return gt("Right-sizing");
    case "orphan_deletion":
      return gt("Orphan cleanup");
    case "sleep_schedule":
      return gt("Sleep schedule");
    case "commitment":
      return gt("Commitments");
    case "manual":
      return gt("Logged manually");
  }
}

function sourceLabel(gt: Gt, source: SavingsEventSource): string {
  switch (source) {
    case "in_app":
      return gt("In Infrawrench");
    case "detected":
      return gt("Detected on sync");
    case "manual":
      return gt("Manual entry");
    case "derived":
      return gt("From billing");
  }
}

function basisLabel(gt: Gt, basis: RealizedSavingsBasis): string {
  switch (basis) {
    case "billing":
      return gt("Measured from billing");
    case "estimate":
      return gt("Estimated from list prices");
    case "manual":
      return gt("As logged");
    case "unmeasured":
      return gt("Not measurable yet");
  }
}

function statusLabel(gt: Gt, status: SavingsEventStatus): string {
  switch (status) {
    case "pending":
      return gt("Waiting for billing");
    case "accruing":
      return gt("Accruing");
    case "complete":
      return gt("Horizon reached");
    case "ended":
      return gt("Ended");
  }
}

export function savingsGroupingLabel(gt: Gt, grouping: RealizedSavingsGrouping): string {
  switch (grouping) {
    case "month":
      return gt("Month");
    case "kind":
      return gt("Action type");
    case "costCentre":
      return gt("Cost centre");
    case "account":
      return gt("Account");
  }
}

/** Month keys render as "Jun 2026"; everything else is already a label. */
function rowLabel(gt: Gt, grouping: RealizedSavingsGrouping, key: string, label: string): string {
  if (grouping === "month") {
    const d = new Date(`${key}-01T00:00:00.000Z`);
    return Number.isNaN(d.getTime())
      ? key
      : d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  }
  if (grouping === "kind") return savingsKindLabel(gt, key as SavingsEventKind);
  if (grouping === "costCentre" && key === "") return gt("Unallocated");
  if (grouping === "account" && key === "") return gt("No account");
  return label;
}

/**
 * Realized vs projected per row, as paired horizontal bars on one scale: a
 * filled bar for what was realized and an outlined one for what was promised,
 * so a shortfall reads as a gap. Values are labelled in text ink beside each
 * row (identity is never colour alone) and every bar carries a tooltip.
 */
export function RealizedSavingsBars({
  report,
  grouping,
  currency,
}: {
  report: RealizedSavingsReport;
  grouping: RealizedSavingsGrouping;
  currency: string;
}) {
  const gt = useGT();
  const rows = realizedSavingsRows(report, grouping, currency);
  if (rows.length === 0) {
    return (
      <p className="text-sm text-on-surface-faint">{gt("Nothing realized in this period.")}</p>
    );
  }
  const max = Math.max(1, ...rows.map((r) => Math.max(Math.abs(r.realized), r.projected)));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4 text-xs text-on-surface-secondary">
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-3 rounded-sm"
            style={{ background: REALIZED_COLOR }}
          />
          {gt("Realized")}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-2 w-3 rounded-sm border"
            style={{ borderColor: REALIZED_COLOR }}
          />
          {gt("Projected")}
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const label = rowLabel(gt, grouping, r.key, r.label);
          const realizedText = formatMoney(r.realized, currency);
          const projectedText = formatMoney(r.projected, currency);
          return (
            <li key={r.key} className="grid grid-cols-[8rem_1fr_auto] items-center gap-3 text-xs">
              <span className="truncate text-on-surface-secondary" title={label}>
                {label}
              </span>
              <div className="flex flex-col gap-0.5">
                <div
                  className="h-2 rounded-r"
                  title={gt("Realized: {amount}", { amount: realizedText })}
                  style={{
                    width: `${(Math.max(0, r.realized) / max) * 100}%`,
                    background: REALIZED_COLOR,
                    minWidth: r.realized > 0 ? 2 : 0,
                  }}
                />
                {r.projected > 0 && (
                  <div
                    className="h-2 rounded-r border"
                    title={gt("Projected: {amount}", { amount: projectedText })}
                    style={{ width: `${(r.projected / max) * 100}%`, borderColor: REALIZED_COLOR }}
                  />
                )}
              </div>
              <span className="tabular-nums text-on-surface whitespace-nowrap">
                {realizedText}
                {r.projected > 0 && (
                  <span className="text-on-surface-faint"> / {projectedText}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Headline tiles: realized vs projected for each currency. */
export function RealizedSavingsTotals({ report }: { report: RealizedSavingsReport }) {
  const gt = useGT();
  if (report.totals.length === 0) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {report.totals.map((t) => {
        const share = t.projected > 0 ? Math.round((t.realized / t.projected) * 100) : null;
        return (
          <div key={t.currency} className="rounded-xl border border-border bg-surface-raised p-3">
            <div className="text-xs text-on-surface-faint">
              {gt("Realized ({currency})", { currency: t.currency })}
            </div>
            <div className="text-lg font-semibold text-on-surface tabular-nums">
              {formatMoney(t.realized, t.currency)}
            </div>
            <div className="text-xs text-on-surface-secondary">
              {share === null
                ? gt("No projection on record")
                : gt("{percent}% of {projected} projected", {
                    percent: share,
                    projected: formatMoney(t.projected, t.currency),
                  })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const RANGE_MONTHS = [3, 6, 12, 24] as const;

function rangeFor(months: number): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return {
    from: from.toISOString().slice(0, 10),
    to: (to < from ? from : to).toISOString().slice(0, 10),
  };
}

export interface RealizedSavingsSectionProps {
  client: CostsClient;
}

/**
 * What the optimization actions taken actually saved, against each resource's
 * own spend before the action, beside what they were projected to save.
 *
 * Sits after the finders on the Costs panel on purpose: those sections say
 * what could be saved; this one is the receipt for what was. Renders nothing
 * when the host has not wired the report.
 */
export function RealizedSavingsSection({ client }: RealizedSavingsSectionProps) {
  const gt = useGT();
  const uid = useId();
  const [months, setMonths] = useState<number>(12);
  const [grouping, setGrouping] = useState<RealizedSavingsGrouping>("month");
  const [report, setReport] = useState<RealizedSavingsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ event: SavingsEventResult | null } | null>(null);
  const [annotating, setAnnotating] = useState<SavingsEventResult | null>(null);
  const [tuning, setTuning] = useState(false);
  const [currency, setCurrency] = useState<string | null>(null);

  const canLog = Boolean(client.createSavingsEvent);
  const canEdit = Boolean(client.updateSavingsEvent);
  const canAnnotate = Boolean(client.annotateSavingsEvent);
  const canDelete = Boolean(client.deleteSavingsEvent);

  const refresh = useCallback(async () => {
    const load = client.getRealizedSavings;
    if (!load) return;
    try {
      setReport(await load(rangeFor(months)));
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, months]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shownCurrency = currency ?? report?.totals[0]?.currency ?? null;

  if (!client.getRealizedSavings) return null;

  async function remove(event: SavingsEventResult) {
    if (!window.confirm(gt('Remove "{title}" from realized savings?', { title: event.title }))) {
      return;
    }
    try {
      await client.deleteSavingsEvent?.(event.id);
      await refresh();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">{gt("Realized savings")}</h2>
          <p className="text-xs text-on-surface-muted mt-1">
            {gt(
              "What resizes, orphan cleanups, sleep schedules, commitments and logged actions actually saved, measured against each resource's own spend before the action.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={`${uid}-range`} className="sr-only">
            {gt("Period")}
          </label>
          <select
            id={`${uid}-range`}
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
            className={selectBaseClass}
          >
            {RANGE_MONTHS.map((m) => (
              <option key={m} value={m}>
                {gt("Last {months} months", { months: m })}
              </option>
            ))}
          </select>
          {client.updateSavingsSettings && (
            <button
              type="button"
              onClick={() => setTuning((open) => !open)}
              aria-expanded={tuning}
              className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
            >
              {tuning ? gt("Hide settings") : gt("Settings")}
            </button>
          )}
          {canLog && (
            <button
              type="button"
              onClick={() => setEditing({ event: null })}
              className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
            >
              {gt("Log a saving")}
            </button>
          )}
        </div>
      </div>

      {tuning && report && client.updateSavingsSettings && (
        <SavingsSettingsPanel
          initial={report.settings}
          save={client.updateSavingsSettings}
          onSaved={() => void refresh()}
        />
      )}

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {gt("Couldn't load realized savings: {error}", { error })}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            {gt("Retry")}
          </button>
        </div>
      )}

      {report === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading realized savings…")}
        </p>
      )}

      {report && report.events.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt(
            "No savings recorded yet. Applying a right-sizing recommendation, deleting a flagged orphan or creating a sleep schedule records one automatically, as does a resize or cleanup done in the provider's console. Anything else can be logged by hand.",
          )}
        </p>
      )}

      {report && report.events.length > 0 && (
        <>
          <RealizedSavingsTotals report={report} />

          {shownCurrency && (
            <div className="rounded-xl border border-border bg-surface-raised p-4 flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-on-surface-secondary">{gt("Break down by")}</span>
                <div role="tablist" className="flex gap-1">
                  {REALIZED_SAVINGS_GROUPINGS.map((g) => (
                    <button
                      key={g}
                      type="button"
                      role="tab"
                      aria-selected={grouping === g}
                      onClick={() => setGrouping(g)}
                      className={tabClass(grouping === g)}
                    >
                      {savingsGroupingLabel(gt, g)}
                    </button>
                  ))}
                </div>
                {report.totals.length > 1 && (
                  <select
                    aria-label={gt("Currency")}
                    value={shownCurrency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className={`${selectBaseClass} ml-auto`}
                  >
                    {report.totals.map((t) => (
                      <option key={t.currency} value={t.currency}>
                        {t.currency}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <RealizedSavingsBars report={report} grouping={grouping} currency={shownCurrency} />
            </div>
          )}

          {(report.shortfallCount > 0 || report.unmeasuredCount > 0) && (
            <p className="text-xs text-warning">
              {report.shortfallCount > 0 &&
                gt("{count} action(s) are realizing less than projected.", {
                  count: report.shortfallCount,
                })}{" "}
              {report.unmeasuredCount > 0 &&
                gt("{count} action(s) have nothing to measure against yet and are not counted.", {
                  count: report.unmeasuredCount,
                })}
            </p>
          )}

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-on-surface-faint">
                  <th scope="col" className="px-3 py-2 font-medium">
                    {gt("Action")}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {gt("Since")}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">
                    {gt("Projected")}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium text-right">
                    {gt("Realized")}
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    <span className="sr-only">{gt("Actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.events.map((event) => (
                  <SavingsEventRow
                    key={event.id}
                    event={event}
                    onEdit={
                      event.editable === "full" && canEdit
                        ? () => setEditing({ event })
                        : event.editable === "annotate" && canAnnotate
                          ? () => setAnnotating(event)
                          : undefined
                    }
                    onDelete={
                      event.editable !== "none" && canDelete ? () => void remove(event) : undefined
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && (
        <SavingsEntryModal
          client={client}
          event={editing.event}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
      {annotating && (
        <SavingsAnnotateModal
          client={client}
          event={annotating}
          onClose={() => setAnnotating(null)}
          onSaved={() => {
            setAnnotating(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}

function SavingsEventRow({
  event,
  onEdit,
  onDelete,
}: {
  event: SavingsEventResult;
  onEdit?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
}) {
  const gt = useGT();
  const realizedCurrency = event.realizedCurrency ?? event.currency ?? "USD";
  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        <div className="text-on-surface">{event.title}</div>
        <div className="text-xs text-on-surface-faint">
          {savingsKindLabel(gt, event.kind)} · {sourceLabel(gt, event.source)}
          {event.accountName ? ` · ${event.accountName}` : ""}
          {event.attributedCostCentreName ? ` · ${event.attributedCostCentreName}` : ""}
        </div>
        <div className="text-xs text-on-surface-faint">
          {basisLabel(gt, event.basis)} · {statusLabel(gt, event.status)}
        </div>
        {event.note && <div className="text-xs text-on-surface-secondary mt-0.5">{event.note}</div>}
        {event.shortfall && (
          <div className="text-xs text-warning mt-0.5">
            {event.shortfall.kind === "grew_back"
              ? gt("Spend is back above the pre-action baseline.")
              : gt("Falling short of the projection.")}{" "}
            <span className="text-on-surface-faint">
              {describeSavingsShortfall(event.shortfall, (n) =>
                formatMonthlyEstimate(n, realizedCurrency),
              )}
            </span>
          </div>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-on-surface-secondary">
        {event.occurredOn}
        {event.endedOn && <div className="text-xs text-on-surface-faint">→ {event.endedOn}</div>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap text-on-surface-secondary">
        {event.projectedMonthlyAmount !== null && event.currency
          ? gt("{amount}/mo", {
              amount: formatMonthlyEstimate(
                Math.round(event.projectedMonthlyAmount * 100) / 100,
                event.currency,
              ),
            })
          : "-"}
      </td>
      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
        {event.realizedInRange !== null ? (
          <>
            <div className="text-on-surface">
              {formatMoney(event.realizedInRange, realizedCurrency)}
            </div>
            {event.projectedInRange !== null && event.currency && (
              <div className="text-xs text-on-surface-faint">
                {gt("of {amount}", { amount: formatMoney(event.projectedInRange, event.currency) })}
              </div>
            )}
          </>
        ) : (
          <span className="text-on-surface-faint">{gt("not measured")}</span>
        )}
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap text-xs">
        {onEdit && (
          <button type="button" onClick={onEdit} className="underline text-on-surface-secondary">
            {gt("Edit")}
          </button>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="ml-2 underline text-on-surface-faint hover:text-danger"
          >
            {gt("Remove")}
          </button>
        )}
      </td>
    </tr>
  );
}

function SavingsSettingsPanel({
  initial,
  save,
  onSaved,
}: {
  initial: RealizedSavingsSettings;
  save: (s: RealizedSavingsSettings) => Promise<RealizedSavingsSettings>;
  onSaved: () => void;
}) {
  const gt = useGT();
  const uid = useId();
  const [draft, setDraft] = useState<RealizedSavingsSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const L = REALIZED_SAVINGS_LIMITS;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await save(draft);
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const field = (
    key: keyof RealizedSavingsSettings,
    label: string,
    help: string,
    min: number,
    max: number,
  ) => (
    <div>
      <label htmlFor={`${uid}-${key}`} className={labelClass}>
        {label}
      </label>
      <input
        id={`${uid}-${key}`}
        type="number"
        min={min}
        max={max}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
        className={selectClass}
      />
      <p className="text-xs text-on-surface-faint mt-1">{help}</p>
    </div>
  );

  return (
    <div className="rounded-xl border border-border bg-surface-raised p-4 flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {field(
          "horizonMonths",
          gt("Horizon (months)"),
          gt("How long a one-off action keeps counting. Sleep schedules count while they run."),
          L.minHorizonMonths,
          L.maxHorizonMonths,
        )}
        {field(
          "shortfallThresholdPercent",
          gt("Shortfall threshold (%)"),
          gt("Flag an action realizing less than this share of its projection."),
          L.minShortfallThresholdPercent,
          L.maxShortfallThresholdPercent,
        )}
        {field(
          "baselineWindowDays",
          gt("Baseline window (days)"),
          gt("Days of spend before the action that make up its baseline."),
          L.minBaselineWindowDays,
          L.maxBaselineWindowDays,
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setDraft({ ...DEFAULT_REALIZED_SAVINGS_SETTINGS })}
          className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface-secondary"
        >
          {gt("Reset to defaults")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {gt("Save")}
        </button>
      </div>
    </div>
  );
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function useCostCentres(client: CostsClient): CostCentre[] {
  const [centres, setCentres] = useState<CostCentre[]>([]);
  useEffect(() => {
    if (!client.listSavingsCostCentres) return;
    let cancelled = false;
    client
      .listSavingsCostCentres()
      .then((c) => {
        if (!cancelled) setCentres(c);
      })
      // Advisory: without the list the picker hides and attribution follows the rules.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client]);
  return centres;
}

/** Log or rewrite a manual entry. */
function SavingsEntryModal({
  client,
  event,
  onClose,
  onSaved,
}: {
  client: CostsClient;
  event: SavingsEventResult | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const gt = useGT();
  const uid = useId();
  const centres = useCostCentres(client);
  const [title, setTitle] = useState(event?.title ?? "");
  const [note, setNote] = useState(event?.note ?? "");
  const [occurredOn, setOccurredOn] = useState(event?.occurredOn ?? todayIso());
  const [endedOn, setEndedOn] = useState(event?.endedOn ?? "");
  const [amount, setAmount] = useState(
    event?.projectedMonthlyAmount !== null && event?.projectedMonthlyAmount !== undefined
      ? String(event.projectedMonthlyAmount)
      : "",
  );
  const [currency, setCurrency] = useState(event?.currency ?? "USD");
  const [costCentreId, setCostCentreId] = useState(event?.costCentreId ?? "");
  const [horizon, setHorizon] = useState(event?.horizonMonths ? String(event.horizonMonths) : "");
  const [resource, setResource] = useState<SavingsResourceOption | null>(
    event?.resourceId
      ? {
          id: event.resourceId,
          displayName: event.resourceName ?? event.resourceId,
          accountId: event.accountId ?? "",
          accountName: event.accountName ?? "",
          resourceTypeLabel: "",
        }
      : null,
  );
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SavingsResourceOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const search = client.searchSavingsResources;
    if (!search || query.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      search(query.trim())
        .then((r) => {
          if (!cancelled) setHits(r.slice(0, 8));
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [client, query]);

  const input: SavingsEventInput = useMemo(
    () => ({
      title: title.trim(),
      note: note.trim() ? note.trim() : null,
      occurredOn,
      endedOn: endedOn || null,
      projectedMonthlyAmount: Number(amount),
      currency: currency.trim().toUpperCase(),
      resourceId: resource?.id ?? null,
      accountId: resource?.accountId || null,
      costCentreId: costCentreId || null,
      horizonMonths: horizon ? Number(horizon) : null,
    }),
    [title, note, occurredOn, endedOn, amount, currency, resource, costCentreId, horizon],
  );
  const invalid = savingsEventInputError(input);

  async function submit() {
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (event) await client.updateSavingsEvent?.(event.id, input);
      else await client.createSavingsEvent?.(input);
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={event ? gt("Edit saving") : gt("Log a saving")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[480px] max-w-full p-6 flex flex-col gap-3">
        <h2 className="text-base font-semibold text-on-surface">
          {event ? gt("Edit saving") : gt("Log a saving")}
        </h2>
        <p className="text-xs text-on-surface-faint">
          {gt(
            "For savings Infrawrench could not see happen: a renegotiated contract, a cancelled vendor, a migrated workload. Link a resource and the realized figure is measured from its billing instead.",
          )}
        </p>
        <div>
          <label htmlFor={`${uid}-title`} className={labelClass}>
            {gt("What was done")}
          </label>
          <input
            id={`${uid}-title`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={REALIZED_SAVINGS_LIMITS.titleMaxLength}
            className={selectClass}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${uid}-amount`} className={labelClass}>
              {gt("Saves per month")}
            </label>
            <input
              id={`${uid}-amount`}
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={selectClass}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-currency`} className={labelClass}>
              {gt("Currency")}
            </label>
            <input
              id={`${uid}-currency`}
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              className={selectClass}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-start`} className={labelClass}>
              {gt("Started on")}
            </label>
            <input
              id={`${uid}-start`}
              type="date"
              value={occurredOn}
              onChange={(e) => setOccurredOn(e.target.value)}
              className={selectClass}
            />
          </div>
          <div>
            <label htmlFor={`${uid}-end`} className={labelClass}>
              {gt("Ended on (optional)")}
            </label>
            <input
              id={`${uid}-end`}
              type="date"
              value={endedOn}
              onChange={(e) => setEndedOn(e.target.value)}
              className={selectClass}
            />
          </div>
        </div>
        {client.searchSavingsResources && (
          <div>
            <label htmlFor={`${uid}-resource`} className={labelClass}>
              {gt("Resource (optional)")}
            </label>
            {resource ? (
              <div className="flex items-center justify-between rounded-lg border border-border px-2.5 py-1.5 text-sm">
                <span className="truncate">
                  {resource.displayName}
                  {resource.accountName && (
                    <span className="text-on-surface-faint"> · {resource.accountName}</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setResource(null)}
                  className="text-xs underline text-on-surface-faint"
                >
                  {gt("Clear")}
                </button>
              </div>
            ) : (
              <>
                <input
                  id={`${uid}-resource`}
                  value={query}
                  placeholder={gt("Search resources by name")}
                  onChange={(e) => setQuery(e.target.value)}
                  className={selectClass}
                />
                {hits.length > 0 && (
                  <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-border">
                    {hits.map((h) => (
                      <li key={h.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setResource(h);
                            setQuery("");
                          }}
                          className="w-full px-2.5 py-1.5 text-left text-sm hover:bg-surface-sunken"
                        >
                          {h.displayName}
                          <span className="text-xs text-on-surface-faint">
                            {" "}
                            · {h.resourceTypeLabel} · {h.accountName}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          {centres.length > 0 && (
            <div>
              <label htmlFor={`${uid}-centre`} className={labelClass}>
                {gt("Cost centre")}
              </label>
              <select
                id={`${uid}-centre`}
                value={costCentreId}
                onChange={(e) => setCostCentreId(e.target.value)}
                className={selectClass}
              >
                <option value="">{gt("From allocation rules")}</option>
                {centres.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label htmlFor={`${uid}-horizon`} className={labelClass}>
              {gt("Horizon (months)")}
            </label>
            <input
              id={`${uid}-horizon`}
              type="number"
              min={REALIZED_SAVINGS_LIMITS.minHorizonMonths}
              max={REALIZED_SAVINGS_LIMITS.maxHorizonMonths}
              value={horizon}
              placeholder={gt("Org default")}
              onChange={(e) => setHorizon(e.target.value)}
              className={selectClass}
            />
          </div>
        </div>
        <div>
          <label htmlFor={`${uid}-note`} className={labelClass}>
            {gt("Note")}
          </label>
          <textarea
            id={`${uid}-note`}
            value={note}
            rows={2}
            maxLength={REALIZED_SAVINGS_LIMITS.noteMaxLength}
            onChange={(e) => setNote(e.target.value)}
            className={selectClass}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface"
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {event ? gt("Save") : gt("Log saving")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Context an automatic event takes: a note, a cost centre, a horizon, an end. */
function SavingsAnnotateModal({
  client,
  event,
  onClose,
  onSaved,
}: {
  client: CostsClient;
  event: SavingsEventResult;
  onClose: () => void;
  onSaved: () => void;
}) {
  const gt = useGT();
  const uid = useId();
  const centres = useCostCentres(client);
  const [note, setNote] = useState(event.note ?? "");
  const [costCentreId, setCostCentreId] = useState(event.costCentreId ?? "");
  const [horizon, setHorizon] = useState(event.horizonMonths ? String(event.horizonMonths) : "");
  const [endedOn, setEndedOn] = useState(event.endedOn ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await client.annotateSavingsEvent?.(event.id, {
        note: note.trim() ? note.trim() : null,
        costCentreId: costCentreId || null,
        horizonMonths: horizon ? Number(horizon) : null,
        endedOn: endedOn || null,
      });
      onSaved();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Edit saving")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[440px] max-w-full p-6 flex flex-col gap-3">
        <h2 className="text-base font-semibold text-on-surface">{event.title}</h2>
        <p className="text-xs text-on-surface-faint">
          {gt(
            "What was done and what it was projected to save are as observed. You can add context, attribute it to a cost centre, change how long it counts, or end it.",
          )}
        </p>
        {centres.length > 0 && (
          <div>
            <label htmlFor={`${uid}-centre`} className={labelClass}>
              {gt("Cost centre")}
            </label>
            <select
              id={`${uid}-centre`}
              value={costCentreId}
              onChange={(e) => setCostCentreId(e.target.value)}
              className={selectClass}
            >
              <option value="">{gt("From allocation rules")}</option>
              {centres.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          {event.kind !== "sleep_schedule" && (
            <div>
              <label htmlFor={`${uid}-horizon`} className={labelClass}>
                {gt("Horizon (months)")}
              </label>
              <input
                id={`${uid}-horizon`}
                type="number"
                min={REALIZED_SAVINGS_LIMITS.minHorizonMonths}
                max={REALIZED_SAVINGS_LIMITS.maxHorizonMonths}
                value={horizon}
                placeholder={gt("Org default")}
                onChange={(e) => setHorizon(e.target.value)}
                className={selectClass}
              />
            </div>
          )}
          <div>
            <label htmlFor={`${uid}-end`} className={labelClass}>
              {gt("Ended on (optional)")}
            </label>
            <input
              id={`${uid}-end`}
              type="date"
              min={event.occurredOn}
              value={endedOn}
              onChange={(e) => setEndedOn(e.target.value)}
              className={selectClass}
            />
          </div>
        </div>
        <div>
          <label htmlFor={`${uid}-note`} className={labelClass}>
            {gt("Note")}
          </label>
          <textarea
            id={`${uid}-note`}
            value={note}
            rows={2}
            maxLength={REALIZED_SAVINGS_LIMITS.noteMaxLength}
            onChange={(e) => setNote(e.target.value)}
            className={selectClass}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface"
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {gt("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The `realized_savings` dashboard card: the headline and one breakdown over
 * the card's months, from the same report the Costs panel reads.
 */
export function RealizedSavingsCard({
  title,
  config,
  api,
  onEdit,
  onRemove,
}: {
  title: string;
  config: { grouping: RealizedSavingsGrouping; months: number };
  api: CostApi;
  onEdit?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
}) {
  const gt = useGT();
  const [report, setReport] = useState<RealizedSavingsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = api.getRealizedSavings;
    if (!load) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await load(rangeFor(config.months));
        if (!cancelled) {
          setReport(r);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, config.months]);

  const primary = report?.totals[0] ?? null;
  return (
    <div className="h-full rounded-xl border border-border bg-surface-raised p-4 flex flex-col gap-3 overflow-hidden">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">
            {title || gt("Realized savings")}
          </h3>
          <p className="text-xs text-on-surface-faint">
            {gt("Last {months} months, by {grouping}", {
              months: config.months,
              grouping: savingsGroupingLabel(gt, config.grouping).toLowerCase(),
            })}
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          {onEdit && (
            <button type="button" onClick={onEdit} className="underline text-on-surface-secondary">
              {gt("Edit")}
            </button>
          )}
          {onRemove && (
            <button type="button" onClick={onRemove} className="underline text-on-surface-faint">
              {gt("Remove")}
            </button>
          )}
        </div>
      </div>
      {!api.getRealizedSavings && (
        <p className="text-sm text-on-surface-faint">{gt("Realized savings are cloud-only.")}</p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      {report && !primary && (
        <p className="text-sm text-on-surface-faint">{gt("Nothing realized in this period.")}</p>
      )}
      {report && primary && (
        <div className="overflow-y-auto flex flex-col gap-3">
          <div>
            <div className="text-2xl font-semibold text-on-surface tabular-nums">
              {formatMoney(primary.realized, primary.currency)}
            </div>
            <div className="text-xs text-on-surface-secondary">
              {gt("realized of {projected} projected", {
                projected: formatMoney(primary.projected, primary.currency),
              })}
              {report.shortfallCount > 0 &&
                ` · ${gt("{count} short", { count: report.shortfallCount })}`}
            </div>
          </div>
          <RealizedSavingsBars
            report={report}
            grouping={config.grouping}
            currency={primary.currency}
          />
        </div>
      )}
    </div>
  );
}

/** Pick a card's breakdown and months. */
export function RealizedSavingsWidgetConfigModal({
  initial,
  onSave,
  onClose,
}: {
  initial: { title: string; grouping: RealizedSavingsGrouping; months: number };
  onSave: (value: {
    title: string;
    grouping: RealizedSavingsGrouping;
    months: number;
  }) => Promise<void> | void;
  onClose: () => void;
}) {
  const gt = useGT();
  const uid = useId();
  const [title, setTitle] = useState(initial.title);
  const [grouping, setGrouping] = useState(initial.grouping);
  const [months, setMonths] = useState(initial.months);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSave({ title: title.trim() || gt("Realized savings"), grouping, months });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={gt("Realized savings card")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[400px] max-w-full p-6 flex flex-col gap-3">
        <h2 className="text-base font-semibold text-on-surface">{gt("Realized savings card")}</h2>
        <div>
          <label htmlFor={`${uid}-title`} className={labelClass}>
            {gt("Title")}
          </label>
          <input
            id={`${uid}-title`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={selectClass}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${uid}-grouping`} className={labelClass}>
              {gt("Break down by")}
            </label>
            <select
              id={`${uid}-grouping`}
              value={grouping}
              onChange={(e) => setGrouping(e.target.value as RealizedSavingsGrouping)}
              className={selectClass}
            >
              {REALIZED_SAVINGS_GROUPINGS.map((g) => (
                <option key={g} value={g}>
                  {savingsGroupingLabel(gt, g)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-months`} className={labelClass}>
              {gt("Months back")}
            </label>
            <select
              id={`${uid}-months`}
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
              className={selectClass}
            >
              {[1, 3, 6, 12, 24, 36].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface"
          >
            {gt("Cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {gt("Save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
