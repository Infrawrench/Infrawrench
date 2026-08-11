import { useEffect, useRef, useState } from "react";

import {
  COST_ANNOTATION_LIMITS,
  COST_ANOMALY_DIMENSION_LABELS,
  costAnomalyDeltaPercent,
  costAnomalyExplanationError,
  costAnomalyExplanationPrefill,
} from "@infrawrench/client-core";
import { formatMoney } from "./transform.js";
import { Modal } from "../components/Modal.js";
import type { CostAnomaly } from "./types.js";

export interface CostAnomalyExplainModalProps {
  anomaly: CostAnomaly;
  /** Saves the explanation. Resolves once the acknowledgement has landed. */
  onSave: (explanation: string) => Promise<void>;
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
 * Write one sentence about why a spike happened.
 *
 * The composer is deliberately smaller than the annotation editor, and the
 * things it does *not* ask are the design:
 *
 * - **No date.** The note goes on the anomalous day. Offering a date field
 *   would only ever let somebody put the marker on the wrong bar.
 * - **No scope.** It is org-wide, which is the whole point: "we migrated the
 *   fleet" explains that day's step on every chart that draws it.
 * - **No blank page.** The box opens with what the row already knows —
 *   "Amazon EC2 spend +173% — " — and the hints detection collected are one
 *   click away, because the difference between this being used and not is
 *   whether finishing a sentence is easier than composing one.
 *
 * What it does say out loud is that the note is going on every chart, and that
 * acknowledging is not silencing: if this key spikes again, it will be found
 * again.
 */
export function CostAnomalyExplainModal({
  anomaly,
  onSave,
  onClose,
}: CostAnomalyExplainModalProps) {
  const existing = anomaly.acknowledgement?.explanation ?? null;
  const [text, setText] = useState(existing ?? costAnomalyExplanationPrefill(anomaly));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Writing the sentence is the only reason this dialog opens, so focus belongs
  // in the box (intentional focus management). Done in an effect rather than
  // with the `autofocus` attribute: `Modal` calls `showModal()` from its own
  // effect, which runs first and moves focus itself, so the attribute's focus
  // lands before the dialog is open and can then be taken back off it.
  useEffect(() => {
    textRef.current?.focus();
  }, []);

  const delta = costAnomalyDeltaPercent(anomaly);
  const isNew = anomaly.kind === "new_source";
  const hints = anomaly.hints ?? [];
  const problem = costAnomalyExplanationError(anomaly, text);
  // The note already exists and is only being reworded — worth saying, because
  // the reader is otherwise entitled to expect a second marker.
  const rewording = existing !== null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await onSave(text.trim());
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} ariaLabel={rewording ? "Edit explanation" : "Explain this anomaly"}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[460px] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">
          {rewording ? "Edit explanation" : "Explain this anomaly"}
        </h2>
        <p className="text-xs text-on-surface-faint mb-4">
          What this was, in a sentence. It is saved on the finding and drawn as a note on{" "}
          <strong className="font-medium">every cost chart</strong> covering{" "}
          {formatDay(anomaly.day)}, so the next person to look at that step already has the answer.
        </p>

        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-red-500">
            {error}
          </div>
        )}

        {/* The facts, restated so nobody has to hold the row in their head
            while writing about it. */}
        <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-xs">
          <dt className="text-on-surface-faint">Day</dt>
          <dd className="text-on-surface">{formatDay(anomaly.day)}</dd>
          <dt className="text-on-surface-faint">
            {COST_ANOMALY_DIMENSION_LABELS[anomaly.dimension]}
          </dt>
          <dd className="text-on-surface">{anomaly.dimensionKey}</dd>
          <dt className="text-on-surface-faint">Spend</dt>
          <dd className="text-on-surface">
            {formatMoney(anomaly.actualCents / 100, anomaly.currency)}{" "}
            <span className="text-on-surface-faint">
              {isNew
                ? "· no prior spend at all"
                : `· against ${formatMoney(anomaly.baselineCents / 100, anomaly.currency)}/day${
                    delta ? ` · ${delta}` : ""
                  }`}
            </span>
          </dd>
        </dl>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-on-surface-secondary">What happened</span>
          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={COST_ANNOTATION_LIMITS.maxTextLength}
            placeholder="Migrated the API fleet to Graviton"
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface"
          />
        </label>

        {hints.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            <span className="text-[11px] text-on-surface-faint">
              Detection found these around then — click to use one:
            </span>
            <div className="flex flex-wrap gap-1">
              {hints.map((hint) => (
                <button
                  key={hint}
                  type="button"
                  onClick={() => setText(`${costAnomalyExplanationPrefill(anomaly)}${hint}`)}
                  className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-on-surface-faint hover:border-border-strong hover:text-on-surface-secondary"
                >
                  {hint}
                </button>
              ))}
            </div>
          </div>
        )}

        {problem && text.trim() !== "" && <p className="mt-3 text-xs text-red-500">{problem}</p>}

        <p className="mt-3 text-[11px] text-on-surface-faint">
          {rewording
            ? "This rewords the note already on the charts rather than adding a second one."
            : "Explaining doesn’t stop detection — if this spikes again, it will be found again."}
        </p>

        <div className="mt-5 flex items-center justify-end gap-2">
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
            onClick={() => void save()}
            className="rounded-lg bg-blue-600 hover:bg-blue-500 px-3 py-1.5 text-sm text-white transition-colors disabled:opacity-50"
          >
            {busy ? "Saving…" : rewording ? "Save" : "Explain"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
