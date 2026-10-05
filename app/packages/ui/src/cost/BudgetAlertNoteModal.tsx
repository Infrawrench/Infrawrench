import { useEffect, useRef, useState } from "react";
import { T, Var, useGT } from "gt-react";

import {
  COST_ANNOTATION_LIMITS,
  budgetAlertDay,
  budgetAlertNoteError,
  budgetAlertNotePrefill,
  type BudgetAlertNoteResult,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import type { BudgetWithStatus } from "./types.js";

type FiredEvent = BudgetWithStatus["currentMonthEvents"][number];

export interface BudgetAlertNoteModalProps {
  budget: Pick<BudgetWithStatus, "name">;
  event: FiredEvent;
  /** Saves the note. Resolves with where the follow-up was posted. */
  onSave: (note: string) => Promise<BudgetAlertNoteResult>;
  onClose: () => void;
}

function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Say why a budget alert fired, in a sentence.
 *
 * The anomaly composer's shape (`CostAnomalyExplainModal`), for the same
 * reasons: no date field (the marker goes on the day the alert fired), no
 * scope (org-wide, so the note explains that day on every chart), and a
 * prefill that restates the alert so the note reads on its own as a marker.
 *
 * What it adds is the follow-up: after saving it says where the note was
 * posted (the alert's Slack threads, its Teams webhooks), because a note that
 * silently went nowhere and one that reached three channels look the same
 * from the form otherwise.
 */
export function BudgetAlertNoteModal({
  budget,
  event,
  onSave,
  onClose,
}: BudgetAlertNoteModalProps) {
  const gt = useGT();
  const existing = event.note?.text ?? null;
  const [text, setText] = useState(existing ?? budgetAlertNotePrefill(budget.name, event));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<BudgetAlertNoteResult["followUp"] | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Writing the sentence is the only reason this dialog opens (see the
  // anomaly composer for why this is an effect rather than `autofocus`).
  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const problem = budgetAlertNoteError(event, text);
  const rewording = existing !== null;
  const day = formatDay(budgetAlertDay(event));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await onSave(text.trim());
      // Nothing to report when the alert reached no chat at all: close.
      if (result.followUp.slack + result.followUp.msTeams === 0) onClose();
      else {
        setPosted(result.followUp);
        setBusy(false);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={rewording ? gt("Edit note") : gt("Explain this alert")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[460px] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {rewording ? gt("Edit note") : gt("Explain this alert")}
        </h2>
        <T>
          <p className="text-xs text-on-surface-faint mb-4">
            Why it fired, in a sentence. It is saved on the alert with your name, drawn as a note on{" "}
            <strong className="font-medium">every cost chart</strong> covering <Var>{day}</Var>, and
            posted under the alert in Slack and Teams.
          </p>
        </T>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}

        {posted ? (
          <div role="status" className="mb-3 text-sm text-on-surface">
            {gt(
              "Saved. Posted as a reply in {slack} Slack thread(s) and to {teams} Teams webhook(s).",
              { slack: posted.slack, teams: posted.msTeams },
            )}
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-on-surface-secondary">{gt("Why it fired")}</span>
              <textarea
                ref={textRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                maxLength={COST_ANNOTATION_LIMITS.maxTextLength}
                placeholder={gt("Q3 load test; expected, ends Friday")}
                className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
              />
            </label>
            {problem && text.trim() !== "" && <p className="mt-3 text-xs text-danger">{problem}</p>}
            <p className="mt-3 text-[11px] text-on-surface-faint">
              {rewording
                ? gt(
                    "This rewrites the note and the marker already on the charts, and posts the new wording under the alert.",
                  )
                : gt(
                    "A note explains the alert; it doesn’t silence the budget's other thresholds.",
                  )}
            </p>
          </>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          {posted ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white transition-colors"
            >
              {gt("Done")}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
              >
                {gt("Cancel")}
              </button>
              <button
                type="button"
                disabled={busy || problem !== null}
                onClick={() => void save()}
                className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white transition-colors disabled:opacity-50"
              >
                {busy ? gt("Saving…") : rewording ? gt("Save") : gt("Add note")}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
