/**
 * Writing findings, whoever found them. The rules (masking, fingerprints,
 * what goes back to the authoring agent) live in server-core
 * (`git-review/findings.ts`), because the app's CI writes findings through
 * them too; the forge's own reviewers (`./runner.ts`) and `findings.report`
 * reach them by the names below. What stays here is what only the forge
 * decides: which reviewer names are its own, and which are CI's.
 */
import { isCiReviewer } from "@infrawrench/client-core";
import { REVIEWER_KINDS, type ReviewerKind } from "@infrawrench/git-contract";

/** Whether a reviewer is one the forge runs itself. Nobody else may report as one. */
export const isForgeReviewer = (kind: string): kind is ReviewerKind =>
  (REVIEWER_KINDS as readonly string[]).includes(kind);

/**
 * A reviewer name Infrawrench CI reports a job's note commands under
 * (`ci:<pipeline>/<job>`). Nobody reports as one through the API: a job
 * that passes marks that name's other findings fixed.
 */
export { isCiReviewer };

export {
  type FindingInput,
  fingerprintOf,
  prepareFinding,
  recordFindings,
  sendMustFixToAgent,
} from "@infrawrench/server-core/git-review/findings";
