import { useCallback, useEffect, useState } from "react";
import { useGT } from "gt-react";
import type {
  CostAnomalyPrecisionReport,
  CostAnomalySensitivity,
  CostAnomalySuppression,
} from "@infrawrench/client-core";

import { formatFeedbackDay, useAnomalyFeedbackLabels } from "./anomaly-feedback-labels.js";
import { SuppressionEditorModal, UpcomingDaysLine } from "./CostAnomalySuppressionFields.js";
import type { CostsClient } from "./types.js";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The suppressions list: what is silenced, how often, until when, and how
 * many findings each one has kept quiet. Editable when the host wires the
 * mutating calls; expired ones stay listed (greyed) as a record.
 */
export function AnomalySuppressionsPanel({ client }: { client: CostsClient }) {
  const gt = useGT();
  const labels = useAnomalyFeedbackLabels();
  const [rows, setRows] = useState<CostAnomalySuppression[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CostAnomalySuppression | "new" | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = client.listAnomalySuppressions;
    if (!list) return;
    try {
      setRows(await list());
      setError(null);
    } catch (e: unknown) {
      setError(errorText(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const canCreate = Boolean(client.createAnomalySuppression);
  const canEdit = Boolean(client.updateAnomalySuppression);
  const canDelete = Boolean(client.deleteAnomalySuppression);

  async function remove(id: string) {
    const del = client.deleteAnomalySuppression;
    if (!del) return;
    setBusyId(id);
    try {
      await del(id);
      setRows((prev) => prev?.filter((r) => r.id !== id) ?? prev);
    } catch (e: unknown) {
      setError(errorText(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-sunken p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-on-surface">{gt("Suppressions")}</h3>
        {canCreate && (
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="rounded-lg border border-border bg-surface-raised px-3 py-1 text-xs text-on-surface hover:border-border-strong"
          >
            {gt("Add suppression")}
          </button>
        )}
      </div>
      <p className="text-xs text-on-surface-faint">
        {gt("Patterns marked as expected. They won't alert again until they expire.")}
      </p>
      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {error}
        </div>
      )}
      {rows === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading suppressions…")}
        </p>
      )}
      {rows?.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt("No suppressions. Mark an anomaly as expected with a recurrence to create one.")}
        </p>
      )}
      {rows !== null && rows.length > 0 && (
        <ul className="divide-y divide-border/50">
          {rows.map((s) => (
            <li
              key={s.id}
              className={`flex flex-wrap items-start justify-between gap-3 py-2 text-sm ${
                s.active ? "" : "opacity-60"
              }`}
            >
              <div className="min-w-0">
                <div className="text-on-surface">
                  <span className="text-xs text-on-surface-faint">{labels.scope(s.scope)} </span>
                  {s.scope === "tag"
                    ? `${s.tagKey ?? ""}=${s.scopeKey}`
                    : (s.scopeLabel ?? s.scopeKey)}
                </div>
                <div className="text-xs text-on-surface-faint">
                  {labels.recurrence(s.recurrence)}
                  {" · "}
                  {gt("{start} to {end}", {
                    start: formatFeedbackDay(s.startsOn),
                    end: formatFeedbackDay(s.expiresOn),
                  })}
                  {s.reason ? ` · ${labels.reason(s.reason)}` : ""}
                  {" · "}
                  {s.active ? gt("active") : gt("expired")}
                  {" · "}
                  {gt("suppressed {count}", { count: s.suppressedCount })}
                </div>
                {s.note && <div className="text-xs text-on-surface-secondary">{s.note}</div>}
                {s.active && <UpcomingDaysLine pattern={s} />}
                {s.createdByName && (
                  <div className="text-[11px] text-on-surface-faint">
                    {gt("Added by {name}", { name: s.createdByName })}
                  </div>
                )}
              </div>
              <span className="inline-flex items-center gap-3">
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => setEditing(s)}
                    className="text-xs text-on-surface-faint underline hover:text-on-surface-secondary"
                  >
                    {gt("Edit")}
                  </button>
                )}
                {canDelete && (
                  <button
                    type="button"
                    disabled={busyId === s.id}
                    onClick={() => void remove(s.id)}
                    className="text-xs text-danger underline disabled:opacity-50"
                  >
                    {gt("Delete")}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {editing !== null && (
        <SuppressionEditorModal
          client={client}
          existing={editing === "new" ? null : editing}
          onSaved={() => void load()}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/**
 * Which providers and services feedback has made less sensitive, and why.
 * Rendered inside the tuning panel, under the org-wide threshold it adjusts.
 */
export function AnomalySensitivityList({ client }: { client: CostsClient }) {
  const gt = useGT();
  const [data, setData] = useState<CostAnomalySensitivity | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const get = client.getAnomalySensitivity;
    if (!get) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await get();
        if (!cancelled) setData(next);
      } catch (e: unknown) {
        if (!cancelled) setError(errorText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (!client.getAnomalySensitivity) return null;
  if (error !== null) {
    return (
      <p role="alert" className="text-xs text-danger">
        {gt("Couldn't load learned sensitivity: {error}", { error })}
      </p>
    );
  }
  if (!data) return null;

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-on-surface-secondary">
        {gt("Learned from feedback")}
      </span>
      {data.adjustments.length === 0 ? (
        <p className="text-[11px] text-on-surface-faint">
          {gt("No verdicts in the last {days} days, so every key uses the threshold above.", {
            days: data.windowDays,
          })}
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-xs">
          {data.adjustments.map((a) => {
            const why =
              a.unexpectedCount > 0
                ? gt("held at {base}σ: {count} marked unexpected in the last {days} days", {
                    base: a.baseSigmas,
                    count: a.unexpectedCount,
                    days: data.windowDays,
                  })
                : a.sigmas > a.baseSigmas && data.enabled
                  ? gt(
                      "raised from {base}σ to {sigmas}σ: {count} marked expected in the last {days} days",
                      {
                        base: a.baseSigmas,
                        sigmas: a.sigmas,
                        count: a.expectedCount,
                        days: data.windowDays,
                      },
                    )
                  : gt("unchanged at {base}σ: {count} marked expected", {
                      base: a.baseSigmas,
                      count: a.expectedCount,
                    });
            return (
              <li key={`${a.dimension}:${a.dimensionKey}`} className="text-on-surface-secondary">
                <span className="text-on-surface">{a.dimensionKey}</span>{" "}
                <span className="text-on-surface-faint">{why}</span>
              </li>
            );
          })}
        </ul>
      )}
      {!data.enabled && (
        <p className="text-[11px] text-warning">
          {gt("Learning from feedback is off, so none of these adjustments apply.")}
        </p>
      )}
    </div>
  );
}

/**
 * Precision over time: of the anomalies somebody reviewed each month, the
 * share that were real problems. Bars are hand-drawn; the numbers are the
 * point and sit beside each bar.
 */
export function AnomalyPrecisionReport({ client }: { client: CostsClient }) {
  const gt = useGT();
  const [months, setMonths] = useState(6);
  const [report, setReport] = useState<CostAnomalyPrecisionReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const labels = useAnomalyFeedbackLabels();

  useEffect(() => {
    const get = client.getAnomalyPrecision;
    if (!get) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await get(months);
        if (!cancelled) {
          setReport(next);
          setError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) setError(errorText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, months]);

  const pct = (v: number | null) => (v === null ? gt("n/a") : `${Math.round(v * 100)}%`);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-sunken p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-on-surface">{gt("Detection precision")}</h3>
        <select
          aria-label={gt("Months to show")}
          value={months}
          onChange={(e) => setMonths(Number(e.target.value))}
          className="rounded-lg border border-border bg-surface-raised px-2 py-1 text-xs text-on-surface"
        >
          {[3, 6, 12, 24].map((m) => (
            <option key={m} value={m}>
              {gt("{months} months", { months: m })}
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-on-surface-faint">
        {gt(
          "Of the anomalies somebody marked, the share that were unexpected (real problems). Suppressed findings never alerted and are counted separately.",
        )}
      </p>
      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {error}
        </div>
      )}
      {report && (
        <>
          <ul className="flex flex-col gap-1.5">
            {report.periods.map((p) => (
              <li
                key={p.month}
                className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-3 text-xs"
              >
                <span className="text-on-surface-faint">{p.month}</span>
                <span
                  className="h-2 rounded-full bg-surface-raised"
                  role="img"
                  aria-label={gt("{month}: {precision} precision", {
                    month: p.month,
                    precision: pct(p.precision),
                  })}
                >
                  <span
                    className="block h-2 rounded-full bg-blue-500"
                    style={{ width: `${Math.round((p.precision ?? 0) * 100)}%` }}
                  />
                </span>
                <span className="whitespace-nowrap text-on-surface-secondary">
                  {pct(p.precision)}{" "}
                  <span className="text-on-surface-faint">
                    {gt(
                      "({unexpected} of {reviewed} reviewed, {detected} found, {suppressed} suppressed)",
                      {
                        unexpected: p.unexpected,
                        reviewed: p.expected + p.unexpected,
                        detected: p.detected,
                        suppressed: p.suppressed,
                      },
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-on-surface-secondary">
            {gt("Overall: {precision} across {reviewed} reviewed anomalies.", {
              precision: pct(report.totals.precision),
              reviewed: report.totals.expected + report.totals.unexpected,
            })}
          </p>
          {report.reasons.length > 0 && (
            <p className="text-xs text-on-surface-faint">
              {gt("Reasons given: {reasons}", {
                reasons: report.reasons
                  .map((r) => `${labels.reason(r.reason)} ${r.count}`)
                  .join(", "),
              })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
