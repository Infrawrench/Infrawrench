import { useState } from "react";

import {
  COST_ANNOTATION_LIMITS,
  costAnnotationInputError,
  type CostAnnotation,
  type CostAnnotationInput,
} from "./config.js";
import { Modal } from "../components/Modal.js";

export interface CostAnnotationModalProps {
  /** The note being edited, or null to create one. */
  annotation: CostAnnotation | null;
  /**
   * The day a new note starts on — the bucket the user clicked, or today. Only
   * used when creating; an edit always starts from the stored dates.
   */
  defaultStartDate: string;
  /**
   * The report this editor was opened from, or undefined on a surface with no
   * report (an ad-hoc dashboard card). Present, the scope choice is offered;
   * absent, every note is org-wide because there is nothing else to scope to.
   */
  reportId?: string | undefined;
  /** Name of that report, for the scope option's label. */
  reportName?: string | undefined;
  onSave: (input: CostAnnotationInput) => Promise<void>;
  onDelete?: (() => Promise<void>) | undefined;
  onClose: () => void;
}

/**
 * Write or edit one dated note.
 *
 * The span is a checkbox rather than two always-visible date fields on purpose:
 * most notes are moments ("deployed the new image"), and an end date sitting
 * there empty invites people to fill it in with the same day, which stores the
 * same fact two ways.
 *
 * Validation is {@link costAnnotationInputError} — the same function the API
 * runs — so the form refuses exactly what the server would refuse, in the same
 * words, before the round trip.
 */
export function CostAnnotationModal({
  annotation,
  defaultStartDate,
  reportId,
  reportName,
  onSave,
  onDelete,
  onClose,
}: CostAnnotationModalProps) {
  const [startDate, setStartDate] = useState(annotation?.startDate ?? defaultStartDate);
  const [spans, setSpans] = useState(Boolean(annotation?.endDate));
  const [endDate, setEndDate] = useState(annotation?.endDate ?? defaultStartDate);
  const [text, setText] = useState(annotation?.text ?? "");
  const [scoped, setScoped] = useState(
    annotation ? annotation.costReportId !== null : Boolean(reportId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input: CostAnnotationInput = {
    startDate,
    endDate: spans ? endDate : null,
    text,
    costReportId: reportId && scoped ? reportId : null,
  };
  const problem = costAnnotationInputError(input);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={annotation ? "Edit annotation" : "Add annotation"}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[440px] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {annotation ? "Edit annotation" : "Add annotation"}
        </h2>
        <p className="text-xs text-on-surface-faint mb-4">
          A dated note drawn over the chart. It never changes the numbers — it explains them.
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-on-surface-secondary">
              {spans ? "First day" : "Date"}
            </span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
            />
          </label>

          <label className="flex items-center gap-2 text-xs text-on-surface-secondary">
            <input
              type="checkbox"
              checked={spans}
              onChange={(e) => setSpans(e.target.checked)}
              className="size-3.5"
            />
            {/* A deploy is a moment; a migration is a week. */}
            Spans several days
          </label>

          {spans && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-on-surface-secondary">Last day</span>
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
              />
            </label>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-xs text-on-surface-secondary">Note</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              maxLength={COST_ANNOTATION_LIMITS.maxTextLength}
              placeholder="Migrated the API fleet to Graviton"
              className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
            />
          </label>

          {reportId && (
            <fieldset className="flex flex-col gap-1">
              <legend className="text-xs text-on-surface-secondary mb-1">Shown on</legend>
              <label className="flex items-center gap-2 text-sm text-on-surface">
                <input
                  type="radio"
                  name="cost-annotation-scope"
                  checked={!scoped}
                  onChange={() => setScoped(false)}
                />
                Every cost chart
              </label>
              <label className="flex items-center gap-2 text-sm text-on-surface">
                <input
                  type="radio"
                  name="cost-annotation-scope"
                  checked={scoped}
                  onChange={() => setScoped(true)}
                />
                <span className="truncate">
                  {reportName ? `Only ${reportName}` : "Only this report"}
                </span>
              </label>
              {/*
                Org-wide is the default worth having: "we changed instance
                types" explains a step change on every chart that shows it, and
                filing it under one report leaves the rest unexplained.
              */}
              <p className="text-[11px] text-on-surface-faint mt-0.5">
                Org-wide notes appear on every cost chart, including dashboard cards.
              </p>
            </fieldset>
          )}
        </div>

        {problem && text.trim() !== "" && <p className="mt-3 text-xs text-danger">{problem}</p>}

        <div className="mt-5 flex items-center justify-between gap-2">
          <div>
            {onDelete && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(onDelete)}
                className="text-xs text-on-surface-faint hover:text-danger underline disabled:opacity-50"
              >
                Delete
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || problem !== null}
              onClick={() => void run(() => onSave({ ...input, text: text.trim() }))}
              className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white transition-colors disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
