/**
 * Explaining an anomaly — the rules, with no database in them.
 *
 * Detection finds a spike and lists it (`anomaly-detect.ts`, `anomaly-eval.ts`).
 * Annotations put a dated note on a chart (`cost_annotations`). Until this
 * module the two never met: somebody read a finding, worked out it was a
 * deliberate migration, and that knowledge died in their head — so the next
 * person to open the chart asked the same question.
 *
 * Acknowledging closes that loop. **The acknowledgement is the act; the
 * annotation is the artifact.** The act is recorded on the anomaly row and
 * cannot be undone by anything that happens to the note afterwards; the note is
 * an ordinary org-wide annotation at the anomaly's own day, and from that moment
 * it belongs to the annotation feature — editable, movable, deletable, drawn on
 * every chart covering that day.
 *
 * Four rules follow, and this file is where they are stated once:
 *
 * 1. **The note is created once.** The first acknowledgement mints it. Later
 *    corrections reword it in place rather than filing a second marker on the
 *    same bar.
 * 2. **A text-only reword.** A correction changes the sentence and nothing
 *    else. Somebody who narrowed the note to one report, or moved its date,
 *    made a deliberate edit in the annotation editor; re-sending the whole
 *    input would quietly undo it.
 * 3. **A deleted note stays deleted.** Deleting the annotation removes the
 *    marker, not the acknowledgement — the anomaly keeps its explanation and
 *    stops being counted as unexplained. A later correction updates that
 *    record without resurrecting a marker somebody removed on purpose.
 * 4. **Nothing here touches detection.** No suppression, no exemption, no
 *    quiet period. An explained spike that happens again next month is a new
 *    finding, and it fires. (See the module note in `anomaly-eval.ts` for the
 *    one silencing mechanism that does exist — the 7-day *notification*
 *    cooldown, which is about not paging twice for one level shift and knows
 *    nothing about explanations.)
 */
import {
  costAnomalyAnnotationInput,
  costAnomalyExplanationError,
  type CostAnnotationInput,
} from "@infrawrench/client-core";

/** The state an acknowledgement acts on — the columns, nothing more. */
export interface AcknowledgeableAnomaly {
  /** The anomalous UTC day; the date the note is filed under. */
  day: string;
  /** Null while nobody has explained this finding. */
  acknowledgedAt: Date | null;
  /** The note this anomaly already minted, or null (never made, or deleted). */
  annotationId: string | null;
}

/** What acknowledging should do to the annotation side. */
export type AnomalyAnnotationPlan =
  /** First acknowledgement: mint the note, org-wide, at the anomaly's day. */
  | { action: "create"; input: CostAnnotationInput }
  /** Correction: reword the note that exists. Text only — see rule 2. */
  | { action: "update"; annotationId: string; text: string }
  /**
   * Correction to a finding whose note was deleted. The explanation is still
   * recorded on the anomaly; there is simply no marker to update, and making a
   * new one would undo a deliberate deletion.
   */
  | { action: "none"; reason: "annotation-deleted" };

/** A rejected explanation — the API maps this to a 400, never a 500. */
export class CostAnomalyAcknowledgeError extends Error {}

/**
 * What acknowledging `anomaly` with `explanation` does to the annotation side.
 *
 * Throws {@link CostAnomalyAcknowledgeError} when the explanation is not one an
 * annotation could hold — empty, or past the note ceiling. The check is
 * `costAnomalyExplanationError`, the same function the composer runs, against
 * the note that would actually be created: a sentence the form accepted and the
 * annotation table then refused would be the worst of both.
 */
export function planAnomalyAcknowledgement(
  anomaly: AcknowledgeableAnomaly,
  explanation: string,
): AnomalyAnnotationPlan {
  const problem = costAnomalyExplanationError(anomaly, explanation);
  if (problem) throw new CostAnomalyAcknowledgeError(problem);

  const input = costAnomalyAnnotationInput(anomaly, explanation);
  if (anomaly.annotationId !== null) {
    return { action: "update", annotationId: anomaly.annotationId, text: input.text };
  }
  // Never acknowledged, so no note was ever made — mint one.
  if (anomaly.acknowledgedAt === null) return { action: "create", input };
  // Acknowledged before, but the note is gone: it was deleted deliberately.
  return { action: "none", reason: "annotation-deleted" };
}
