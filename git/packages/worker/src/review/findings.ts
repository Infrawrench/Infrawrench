/**
 * Writing findings, whoever found them: the forge's own reviewers
 * (`./runner.ts`) and a reviewer outside it (`findings.report`) go through
 * here, so both are masked, fingerprinted and sent to the authoring agent by
 * the same rules.
 *
 * - **Masked before stored.** A title, a body and every piece of evidence
 *   goes through `maskSecrets`: a finding quotes code and CI logs, and it is
 *   read by everyone who can read the repository.
 * - **Fingerprinted** by reviewer, path and title (not the line, which moves
 *   from version to version), unless the reporter gave its own.
 * - **A must-fix finding on an agent's branch goes back to the agent** as a
 *   queued instruction, when it is raised and when it comes back after
 *   having been fixed. Not when it is merely seen again: the agent already
 *   has it, and a person decides what happens next.
 */
import { REVIEWER_KINDS, type ReviewerKind } from "@infrawrench/git-contract";
import type { GitFindingEvidence, GitFindingSeverity } from "@infrawrench/server-core/db/schema";
import { queueFindingInstructions } from "../db/finding-instructions";
import {
  type FindingOutcome,
  type FindingRow,
  type FindingTarget,
  type NewFinding,
  upsertFinding,
} from "../db/findings";
import { getAgentLink } from "../db/review";
import { maskSecrets } from "./masking";
import { findingCodeAnchor, resolveNeedsCode } from "./needs-code";

/** Whether a reviewer is one the forge runs itself. Nobody else may report as one. */
export const isForgeReviewer = (kind: string): kind is ReviewerKind =>
  (REVIEWER_KINDS as readonly string[]).includes(kind);

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Case, punctuation and spacing do not make a different finding. */
const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The same for the same finding on a later version: reviewer, path and title, never the line. */
export const fingerprintOf = async (
  reviewerKind: string,
  path: string | null,
  title: string,
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${reviewerKind}\n${path ?? ""}\n${normalise(title)}`),
  );
  return `${reviewerKind.slice(0, 32)}:${hex(digest).slice(0, 32)}`;
};

export interface FindingInput {
  readonly severity: GitFindingSeverity;
  readonly title: string;
  readonly body?: string | undefined;
  readonly path?: string | null | undefined;
  readonly side?: "LEFT" | "RIGHT" | undefined;
  readonly startLine?: number | null | undefined;
  readonly endLine?: number | null | undefined;
  /** Left out, it is resolved from the path and the lines (`./needs-code.ts`). */
  readonly needsCode?: boolean | undefined;
  readonly evidence?: readonly GitFindingEvidence[] | undefined;
  readonly fingerprint?: string | undefined;
}

const cut = (text: string, limit: number): string =>
  text.length > limit
    ? `${text.slice(0, limit)}\n[cut: ${text.length - limit} more characters]`
    : text;

/** A finding as it is stored: masked, bounded, with its fingerprint and its lines in order. */
export const prepareFinding = async (
  reviewerKind: string,
  input: FindingInput,
): Promise<NewFinding> => {
  const path = input.path == null || input.path === "" ? null : input.path.replace(/^\/+/, "");
  // Lines only mean something in a file.
  let startLine = path === null ? null : (input.startLine ?? input.endLine ?? null);
  let endLine = path === null ? null : (input.endLine ?? input.startLine ?? null);
  if (startLine !== null && endLine !== null && endLine < startLine) {
    [startLine, endLine] = [endLine, startLine];
  }
  const title = maskSecrets(input.title).replace(/\s+/g, " ").trim().slice(0, 256);
  return {
    reviewerKind,
    // From the title as written, so masking never makes two findings one.
    fingerprint: input.fingerprint ?? (await fingerprintOf(reviewerKind, path, input.title)),
    severity: input.severity,
    title: title === "" ? "Untitled finding" : title,
    body: cut(maskSecrets(input.body ?? ""), 65_536),
    path,
    side: input.side ?? "RIGHT",
    startLine,
    endLine,
    needsCode: resolveNeedsCode(input.needsCode, findingCodeAnchor({ path, startLine, endLine })),
    evidence: (input.evidence ?? []).slice(0, 32).map((evidence) => ({
      kind: evidence.kind.slice(0, 64),
      text: cut(maskSecrets(evidence.text), 16_384),
      url: evidence.url ? maskSecrets(evidence.url).slice(0, 2048) : null,
    })),
  };
};

/** Send the must-fix findings among these to the pull request's agent, when it has one. */
export const sendMustFixToAgent = async (
  target: Pick<FindingTarget, "repositoryId" | "pullRequestId">,
  written: ReadonlyArray<{ readonly row: FindingRow; readonly outcome: FindingOutcome }>,
): Promise<number> => {
  const findings = written
    .filter(
      ({ row, outcome }) =>
        row.severity === "must_fix" && (outcome === "raised" || outcome === "reopened"),
    )
    .map(({ row }) => row);
  if (findings.length === 0) return 0;
  if (!(await getAgentLink(target.pullRequestId))) return 0;
  const sent = await queueFindingInstructions({
    repositoryId: target.repositoryId,
    pullRequestId: target.pullRequestId,
    findings,
    createdByUserId: null,
  });
  return sent.length;
};

/** Write findings a reviewer has on a version, and send what the agent must fix back to it. */
export const recordFindings = async (
  target: FindingTarget,
  reviewerKind: string,
  inputs: readonly FindingInput[],
): Promise<Array<{ readonly row: FindingRow; readonly outcome: FindingOutcome }>> => {
  const written: Array<{ row: FindingRow; outcome: FindingOutcome }> = [];
  for (const input of inputs) {
    written.push(await upsertFinding(target, await prepareFinding(reviewerKind, input)));
  }
  await sendMustFixToAgent(target, written);
  return written;
};
