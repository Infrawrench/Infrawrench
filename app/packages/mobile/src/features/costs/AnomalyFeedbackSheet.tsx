import { useState } from "react";
import {
  COST_ANOMALY_DIMENSION_LABELS,
  COST_ANOMALY_FEEDBACK_LIMITS,
  COST_ANOMALY_FEEDBACK_REASON_LABELS,
  COST_ANOMALY_FEEDBACK_REASONS,
  COST_ANOMALY_RECURRENCE_LABELS,
  COST_ANOMALY_RECURRENCES,
  type CostAnomaly,
  type CostAnomalyFeedbackInput,
  type CostAnomalyFeedbackReason,
  type CostAnomalyRecurrence,
  type CostAnomalyVerdict,
} from "@infrawrench/client-core";
import { ChipSelect, FormError, FormHint, Sheet, SheetActions, TextField } from "@/components/form";
import { costAnomalyFeedbackErrorMessage, useCostAnomalyFeedback } from "./useCostAnomalies";

type RecurrenceChoice = "none" | CostAnomalyRecurrence;

const RECURRENCE_OPTIONS: ReadonlyArray<{ value: RecurrenceChoice; label: string }> = [
  { value: "none", label: "None" },
  ...COST_ANOMALY_RECURRENCES.map((r) => ({ value: r, label: COST_ANOMALY_RECURRENCE_LABELS[r] })),
];

const REASON_OPTIONS = COST_ANOMALY_FEEDBACK_REASONS.map((r) => ({
  value: r,
  label: COST_ANOMALY_FEEDBACK_REASON_LABELS[r],
}));

/**
 * Give one anomaly a verdict: the native counterpart of the feedback popover
 * on web and desktop, over the same `POST /costs/anomalies/:id/feedback`.
 *
 * Deliberately narrower than the web editor. The reason and note are the
 * same; for an `expected` verdict the "stop this alerting again" choice is
 * only the recurrence, because the suppression it creates is always scoped to
 * the anomaly's own provider or service and expires on the server's default
 * for that recurrence. Picking a different scope (an account, a tag, a cost
 * centre) or a custom expiry, and editing suppressions afterwards, belong to
 * the suppression list on web and desktop.
 */
export function AnomalyFeedbackSheet({
  anomaly,
  verdict,
  onClose,
}: {
  anomaly: CostAnomaly;
  verdict: CostAnomalyVerdict;
  onClose: () => void;
}) {
  // Re-opening the same verdict edits it, so start from what was said.
  const existing = anomaly.feedback?.verdict === verdict ? anomaly.feedback : null;
  const [reason, setReason] = useState<CostAnomalyFeedbackReason | null>(existing?.reason ?? null);
  const [note, setNote] = useState(existing?.note ?? "");
  const [recurrence, setRecurrence] = useState<RecurrenceChoice>("none");
  const [error, setError] = useState<string | null>(null);
  const { submit } = useCostAnomalyFeedback();

  // An earlier `expected` verdict's suppression survives a re-send without a
  // recurrence, and is replaced by one with.
  const hasSuppression = verdict === "expected" && Boolean(anomaly.feedback?.suppressionId);
  const scopeLabel = COST_ANOMALY_DIMENSION_LABELS[anomaly.dimension].toLowerCase();

  async function save() {
    setError(null);
    const trimmed = note.trim();
    const feedback: CostAnomalyFeedbackInput = {
      verdict,
      reason,
      note: trimmed ? trimmed : null,
      ...(verdict === "expected" && recurrence !== "none" ? { suppress: { recurrence } } : {}),
    };
    try {
      await submit.mutateAsync({ anomalyId: anomaly.id, feedback });
      onClose();
    } catch (e) {
      setError(costAnomalyFeedbackErrorMessage(e));
    }
  }

  return (
    <Sheet
      visible
      title={verdict === "expected" ? "Mark as expected" : "Mark as unexpected"}
      description={
        verdict === "expected"
          ? `${anomaly.dimensionKey} on ${anomaly.day} was planned or known. Repeated expected verdicts make detection a little less sensitive to this ${scopeLabel}.`
          : `${anomaly.dimensionKey} on ${anomaly.day} was a real problem. This keeps detection sensitive to this ${scopeLabel}.`
      }
      onClose={onClose}
      footer={
        <SheetActions
          onCancel={onClose}
          onSubmit={() => void save()}
          submitLabel="Save"
          submitting={submit.isPending}
        />
      }
    >
      <ChipSelect
        label="Reason (optional)"
        options={REASON_OPTIONS}
        value={reason}
        // Tapping the chosen chip again clears it: the reason is optional.
        onChange={(r) => setReason(r === reason ? null : r)}
      />
      <TextField
        label="Note (optional)"
        value={note}
        onChangeText={setNote}
        placeholder={verdict === "expected" ? "Black Friday load test" : "Runaway batch job"}
        multiline
        autoCapitalize="sentences"
        maxLength={COST_ANOMALY_FEEDBACK_LIMITS.noteMaxLength}
      />
      {verdict === "expected" && (
        <>
          <ChipSelect
            label="Stop this alerting again"
            hint={`Spend on this ${scopeLabel} is set aside on matching days until the default expiry, so a finding it explains is stored but not alerted.`}
            options={RECURRENCE_OPTIONS}
            value={recurrence}
            onChange={setRecurrence}
          />
          {hasSuppression && (
            <FormHint>
              This finding already has a suppression. None keeps it as it is; picking a pattern
              replaces it. Clear feedback removes it.
            </FormHint>
          )}
        </>
      )}
      {verdict === "unexpected" && hasExistingExpectedSuppression(anomaly) && (
        <FormHint>The suppression the earlier expected verdict created will be removed.</FormHint>
      )}
      <FormError message={error} />
    </Sheet>
  );
}

function hasExistingExpectedSuppression(anomaly: CostAnomaly): boolean {
  return anomaly.feedback?.verdict === "expected" && Boolean(anomaly.feedback.suppressionId);
}
