import { useId, useState, type ReactNode } from "react";
import { T, Var, useGT } from "gt-react";
import {
  COST_ANOMALY_FEEDBACK_LIMITS,
  COST_ANOMALY_FEEDBACK_REASONS,
  COST_ANOMALY_RECURRENCES,
  defaultSuppressionExpiry,
  type CostAnomalyFeedbackInput,
  type CostAnomalyFeedbackReason,
  type CostAnomalyRecurrence,
  type CostAnomalyVerdict,
} from "@infrawrench/client-core";

import { Modal } from "../components/Modal.js";
import { formatMoney } from "./transform.js";
import {
  formatFeedbackDay,
  todayIsoDay,
  useAnomalyFeedbackLabels,
} from "./anomaly-feedback-labels.js";
import {
  SuppressionScopeFields,
  UpcomingDaysLine,
  type ScopeValue,
} from "./CostAnomalySuppressionFields.js";
import type { CostAnomaly, CostsClient } from "./types.js";

const fieldClass =
  "rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:border-blue-500 disabled:opacity-60";

export interface CostAnomalyFeedbackModalProps {
  client: CostsClient;
  anomaly: CostAnomaly;
  /** The verdict the row's button preselected. */
  initialVerdict: CostAnomalyVerdict;
  /** Called with the updated anomaly after a save or a clear. */
  onChanged: (anomaly: CostAnomaly) => void;
  onClose: () => void;
  /** The row's existing "File in Jira/Linear" action, offered for unexpected findings. */
  fileIssue?: ReactNode;
}

function laterDay(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * Expected or unexpected, and what follows. An expected finding can stop the
 * same pattern alerting (a suppression with a recurrence, a scope and an
 * expiry); an unexpected one keeps detection as sensitive as it is and points
 * at the issue tracker. Both may carry a reason and a note, and the note can
 * also go on the charts as the finding's explanation.
 */
export function CostAnomalyFeedbackModal({
  client,
  anomaly,
  initialVerdict,
  onChanged,
  onClose,
  fileIssue,
}: CostAnomalyFeedbackModalProps) {
  const gt = useGT();
  const labels = useAnomalyFeedbackLabels();
  const uid = useId();
  const existing = anomaly.feedback ?? null;
  const [verdict, setVerdict] = useState<CostAnomalyVerdict>(initialVerdict);
  const [reason, setReason] = useState<CostAnomalyFeedbackReason | "">(existing?.reason ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [explain, setExplain] = useState(false);
  const [recurrence, setRecurrence] = useState<CostAnomalyRecurrence | "">("");
  const [scope, setScope] = useState<ScopeValue>({
    scope: anomaly.dimension,
    scopeKey: anomaly.dimensionKey,
    tagKey: "",
  });
  const [expiresOn, setExpiresOn] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = client.submitAnomalyFeedback;
  const clear = client.clearAnomalyFeedback;
  const today = todayIsoDay();
  const defaultExpiry = recurrence
    ? laterDay(
        defaultSuppressionExpiry(recurrence, anomaly.day),
        defaultSuppressionExpiry(recurrence, today),
      )
    : "";
  const effectiveExpiry = expiresOn || defaultExpiry;
  const canExplain = Boolean(client.acknowledgeAnomaly) && !anomaly.acknowledgement;

  async function save() {
    if (!submit) return;
    setBusy(true);
    setError(null);
    const trimmed = note.trim();
    const input: CostAnomalyFeedbackInput = {
      verdict,
      reason: reason || null,
      note: trimmed || null,
      ...(explain && trimmed ? { explain: true } : {}),
      ...(verdict === "expected" && recurrence
        ? {
            suppress: {
              recurrence,
              scope: scope.scope,
              scopeKey: scope.scopeKey,
              ...(scope.scope === "tag" ? { tagKey: scope.tagKey } : {}),
              ...(expiresOn ? { expiresOn } : {}),
            },
          }
        : {}),
    };
    try {
      const result = await submit(anomaly.id, input);
      onChanged(result.anomaly);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!clear) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await clear(anomaly.id));
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const scopeIncomplete =
    verdict === "expected" &&
    recurrence !== "" &&
    (!scope.scopeKey || (scope.scope === "tag" && !scope.tagKey));

  const verdictButton = (v: CostAnomalyVerdict) => (
    <button
      type="button"
      aria-pressed={verdict === v}
      disabled={busy}
      onClick={() => setVerdict(v)}
      className={`flex-1 rounded-lg border px-3 py-2 text-sm ${
        verdict === v
          ? v === "expected"
            ? "border-emerald-500/60 bg-emerald-500/10 text-success"
            : "border-red-500/60 bg-red-500/10 text-danger"
          : "border-border text-on-surface-secondary hover:border-border-strong"
      }`}
    >
      {labels.verdict(v)}
    </button>
  );

  return (
    <Modal onClose={onClose} ariaLabel={gt("Anomaly feedback")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[520px] max-w-full p-6 flex flex-col gap-4">
        <div>
          <h2 className="text-base font-semibold text-on-surface mb-1">
            {gt("Was this anomaly expected?")}
          </h2>
          <T>
            <p className="text-xs text-on-surface-faint">
              <Var>{anomaly.dimensionKey}</Var> spent{" "}
              <Var>{formatMoney(anomaly.actualCents / 100, anomaly.currency)}</Var> on{" "}
              <Var>{formatFeedbackDay(anomaly.day)}</Var>. Your answer tunes detection for this
              organization.
            </p>
          </T>
          {existing && (
            <p className="mt-1 text-[11px] text-on-surface-faint">
              {existing.byName
                ? gt("Currently {verdict}, by {name} on {day}.", {
                    verdict: labels.verdict(existing.verdict),
                    name: existing.byName,
                    day: formatFeedbackDay(existing.at),
                  })
                : gt("Currently {verdict}, since {day}.", {
                    verdict: labels.verdict(existing.verdict),
                    day: formatFeedbackDay(existing.at),
                  })}
            </p>
          )}
        </div>

        {error !== null && (
          <div role="alert" className="text-sm text-danger">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          {verdictButton("expected")}
          {verdictButton("unexpected")}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor={`${uid}-reason`}>
            <span className="text-xs text-on-surface-secondary">{gt("Reason")}</span>
            <select
              id={`${uid}-reason`}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value as CostAnomalyFeedbackReason | "")}
              className={fieldClass}
            >
              <option value="">{gt("No reason")}</option>
              {COST_ANOMALY_FEEDBACK_REASONS.map((r) => (
                <option key={r} value={r}>
                  {labels.reason(r)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2" htmlFor={`${uid}-note`}>
            <span className="text-xs text-on-surface-secondary">{gt("Note")}</span>
            <textarea
              id={`${uid}-note`}
              rows={2}
              value={note}
              disabled={busy}
              maxLength={COST_ANOMALY_FEEDBACK_LIMITS.noteMaxLength}
              onChange={(e) => setNote(e.target.value)}
              placeholder={gt("Black Friday load test, planned with the platform team")}
              className={fieldClass}
            />
          </label>
        </div>
        {canExplain && note.trim() !== "" && (
          <label className="flex items-center gap-2 text-xs text-on-surface-secondary">
            <input
              type="checkbox"
              checked={explain}
              disabled={busy}
              onChange={(e) => setExplain(e.target.checked)}
            />
            {gt("Also put this note on every cost chart for this day (explain the anomaly)")}
          </label>
        )}

        {verdict === "expected" ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-3">
            <label className="flex flex-col gap-1" htmlFor={`${uid}-rec`}>
              <span className="text-xs text-on-surface-secondary">
                {gt("Stop the same pattern alerting")}
              </span>
              <select
                id={`${uid}-rec`}
                value={recurrence}
                disabled={busy}
                onChange={(e) => {
                  setRecurrence(e.target.value as CostAnomalyRecurrence | "");
                  setExpiresOn("");
                }}
                className={fieldClass}
              >
                <option value="">{gt("Don't suppress future alerts")}</option>
                {COST_ANOMALY_RECURRENCES.map((r) => (
                  <option key={r} value={r}>
                    {labels.recurrence(r)}
                  </option>
                ))}
              </select>
            </label>
            {recurrence !== "" && (
              <>
                <SuppressionScopeFields
                  client={client}
                  value={scope}
                  onChange={setScope}
                  disabled={busy}
                />
                <label className="flex flex-col gap-1" htmlFor={`${uid}-expires`}>
                  <span className="text-xs text-on-surface-secondary">{gt("Expires")}</span>
                  <input
                    id={`${uid}-expires`}
                    type="date"
                    value={effectiveExpiry}
                    disabled={busy}
                    onChange={(e) => setExpiresOn(e.target.value)}
                    className={`${fieldClass} sm:w-48`}
                  />
                </label>
                <UpcomingDaysLine
                  pattern={{
                    recurrence,
                    anchorDay: anomaly.day,
                    startsOn: anomaly.day,
                    expiresOn: effectiveExpiry,
                  }}
                />
              </>
            )}
            <p className="text-[11px] text-on-surface-faint">
              {gt(
                "Repeated expected verdicts on the same provider or service also make its spike threshold slightly less sensitive, within limits shown in Tune detection.",
              )}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3">
            <p className="text-[11px] text-on-surface-faint">
              {gt(
                "Unexpected keeps detection as sensitive as it is. If an earlier expected verdict on this anomaly created a suppression, it is removed.",
              )}
            </p>
            {fileIssue && <div className="text-xs">{fileIssue}</div>}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <div>
            {existing && clear && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void withdraw()}
                className="text-xs text-on-surface-faint underline hover:text-on-surface-secondary disabled:opacity-50"
              >
                {gt("Clear feedback")}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
            >
              {gt("Cancel")}
            </button>
            <button
              type="button"
              disabled={busy || !submit || scopeIncomplete}
              onClick={() => void save()}
              className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white transition-colors disabled:opacity-50"
            >
              {busy ? gt("Saving…") : gt("Save feedback")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
