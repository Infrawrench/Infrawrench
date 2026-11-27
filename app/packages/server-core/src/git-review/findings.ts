/**
 * Writing findings, whoever found them: the forge's own reviewers (its
 * `review/runner.ts`), a reviewer outside it (`findings.report`) and a CI
 * job's note commands (`ci/git-notes.ts`) all go through here, so every
 * finding is masked, fingerprinted, carried from version to version and sent
 * to the authoring agent by the same rules. The merge block reads the rows
 * this writes and nothing else, so a must-fix holds a merge whoever raised
 * it.
 *
 * It lives in server-core because both sides write: the forge's Worker
 * imports it (its `review/findings.ts`, `db/findings.ts` and
 * `db/finding-instructions.ts` are these functions under the names its
 * modules know), and the app's CI calls it directly, as it writes commit
 * statuses. Nothing here reaches past Postgres, so it runs in a Worker.
 *
 * - **Masked before stored.** A title, a body and every piece of evidence
 *   goes through `maskSecrets`: a finding quotes code and CI logs, and it is
 *   read by everyone who can read the repository.
 * - **Fingerprinted** by reviewer, path and title (not the line, which moves
 *   from version to version), unless the reporter gave its own. A finding is
 *   one row for the life of its pull request (the fingerprint is unique per
 *   pull request): writing one that is already there updates it, reopens it
 *   when it was fixed, and leaves it alone when a person dismissed it. That
 *   is how a dismissal is remembered.
 * - **A must-fix finding on an agent's branch goes back to the agent** as a
 *   queued instruction, when it is raised and when it comes back after
 *   having been fixed. Not when it is merely seen again: the agent already
 *   has it, and a person decides what happens next.
 */
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  type GitDiffSide,
  type GitFindingEvidence,
  type GitFindingSeverity,
  gitAgentLinks,
  gitBranchVersions,
  gitInstructions,
  gitReviewFindings,
} from "../db/schema.js";
import { maskSecrets } from "./masking.js";
import { findingCodeAnchor, resolveNeedsCode } from "./needs-code.js";

export type FindingRow = typeof gitReviewFindings.$inferSelect;
type VersionRow = typeof gitBranchVersions.$inferSelect;

/** A new row id: a UUID, like every other id in the schema. */
const newId = (): string => crypto.randomUUID();

// ---------------------------------------------------------------------------
// From what a reviewer said to what is stored
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface NewFinding {
  readonly reviewerKind: string;
  readonly fingerprint: string;
  readonly severity: GitFindingSeverity;
  readonly title: string;
  readonly body: string;
  readonly path: string | null;
  readonly side: GitDiffSide;
  readonly startLine: number | null;
  readonly endLine: number | null;
  /** Resolved already (`review/needs-code.ts`). A later report's value replaces an earlier one's. */
  readonly needsCode: boolean;
  readonly evidence: readonly GitFindingEvidence[];
}

export interface FindingTarget {
  readonly repositoryId: string;
  readonly pullRequestId: string;
  /** The version the finding was seen on. Its commit is the one the lines are numbered in. */
  readonly version: Pick<VersionRow, "id" | "number" | "tipOid">;
  readonly runId: string | null;
}

/**
 * What writing a finding did: `raised` for a new one, `reopened` for one that
 * had been marked fixed, `seen` for one that was open already, and
 * `dismissed` for one a person dismissed, which is left exactly as it was.
 */
export type FindingOutcome = "raised" | "reopened" | "seen" | "dismissed";

/**
 * Write a finding by its fingerprint. An older version never overwrites what
 * a newer one saw: a run that finishes late leaves the newer anchors alone.
 */
export const upsertFinding = async (
  target: FindingTarget,
  finding: NewFinding,
): Promise<{ readonly row: FindingRow; readonly outcome: FindingOutcome }> => {
  const { version } = target;
  const content = {
    runId: target.runId,
    reviewerKind: finding.reviewerKind,
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    path: finding.path,
    side: finding.side,
    startLine: finding.startLine,
    endLine: finding.endLine,
    needsCode: finding.needsCode,
    commitOid: version.tipOid,
    evidence: [...finding.evidence],
  };
  const [inserted] = await db
    .insert(gitReviewFindings)
    .values({
      id: newId(),
      repositoryId: target.repositoryId,
      pullRequestId: target.pullRequestId,
      versionId: version.id,
      versionNumber: version.number,
      lastSeenVersionNumber: version.number,
      fingerprint: finding.fingerprint,
      ...content,
    })
    .onConflictDoNothing({
      target: [gitReviewFindings.pullRequestId, gitReviewFindings.fingerprint],
    })
    .returning();
  if (inserted) return { row: inserted, outcome: "raised" };

  const [existing] = await db
    .select()
    .from(gitReviewFindings)
    .where(
      and(
        eq(gitReviewFindings.pullRequestId, target.pullRequestId),
        eq(gitReviewFindings.fingerprint, finding.fingerprint),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("A finding vanished while it was being written");
  if (existing.status === "dismissed") return { row: existing, outcome: "dismissed" };
  // Seen by a newer version already: this report is of the past.
  if (existing.lastSeenVersionNumber > version.number) return { row: existing, outcome: "seen" };
  if (existing.status === "fixed" && (existing.fixedInVersionNumber ?? 0) > version.number) {
    return { row: existing, outcome: "seen" };
  }
  const [updated] = await db
    .update(gitReviewFindings)
    .set({
      ...content,
      status: "open",
      fixedInVersionNumber: null,
      lastSeenVersionNumber: version.number,
      updatedAt: new Date(),
    })
    // Not one a person dismissed in the meantime.
    .where(and(eq(gitReviewFindings.id, existing.id), ne(gitReviewFindings.status, "dismissed")))
    .returning();
  if (!updated) return { row: existing, outcome: "dismissed" };
  return { row: updated, outcome: existing.status === "fixed" ? "reopened" : "seen" };
};

/**
 * A reviewer said this is everything it finds on a version: its open
 * findings last seen before that version are fixed in it.
 */
export const markUnseenFixed = async (
  pullRequestId: string,
  reviewerKind: string,
  versionNumber: number,
): Promise<FindingRow[]> =>
  db
    .update(gitReviewFindings)
    .set({ status: "fixed", fixedInVersionNumber: versionNumber, updatedAt: new Date() })
    .where(
      and(
        eq(gitReviewFindings.pullRequestId, pullRequestId),
        eq(gitReviewFindings.reviewerKind, reviewerKind),
        eq(gitReviewFindings.status, "open"),
        sql`${gitReviewFindings.lastSeenVersionNumber} < ${versionNumber}`,
      ),
    )
    .returning();

/**
 * A reviewer's whole answer for a version, told by what it reported rather
 * than by a version number: its open findings that are not among `seenIds`
 * and were last seen on this version or before are fixed in it.
 *
 * This is {@link markUnseenFixed} for a reviewer that can run twice on one
 * version (a CI job that is run again): a finding the first run raised on
 * the version and the second no longer does is fixed, where
 * `markUnseenFixed` would leave it open until the next push. Only ever one
 * reviewer's findings: a reviewer answers for what it found itself.
 */
export const markOthersFixed = async (
  pullRequestId: string,
  reviewerKind: string,
  versionNumber: number,
  seenIds: readonly string[],
): Promise<FindingRow[]> =>
  db
    .update(gitReviewFindings)
    .set({ status: "fixed", fixedInVersionNumber: versionNumber, updatedAt: new Date() })
    .where(
      and(
        eq(gitReviewFindings.pullRequestId, pullRequestId),
        eq(gitReviewFindings.reviewerKind, reviewerKind),
        eq(gitReviewFindings.status, "open"),
        sql`${gitReviewFindings.lastSeenVersionNumber} <= ${versionNumber}`,
        seenIds.length > 0 ? notInArray(gitReviewFindings.id, [...seenIds]) : undefined,
      ),
    )
    .returning();

/**
 * A reviewer did not look again and what it read has not changed (a CI job
 * the task cache stood in for): its open findings are still there on this
 * version, on the same lines, numbered in the version's commit.
 */
export const carryFindings = async (
  pullRequestId: string,
  reviewerKind: string,
  version: Pick<VersionRow, "number" | "tipOid">,
): Promise<FindingRow[]> =>
  db
    .update(gitReviewFindings)
    .set({
      lastSeenVersionNumber: version.number,
      commitOid: version.tipOid,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(gitReviewFindings.pullRequestId, pullRequestId),
        eq(gitReviewFindings.reviewerKind, reviewerKind),
        eq(gitReviewFindings.status, "open"),
        sql`${gitReviewFindings.lastSeenVersionNumber} < ${version.number}`,
      ),
    )
    .returning();

// ---------------------------------------------------------------------------
// Back to the agent
// ---------------------------------------------------------------------------

export type InstructionRow = typeof gitInstructions.$inferSelect;

const lineRange = (finding: Pick<FindingRow, "startLine" | "endLine">): string => {
  if (finding.startLine === null) return "";
  return finding.endLine !== null && finding.endLine !== finding.startLine
    ? `:${finding.startLine}-${finding.endLine}`
    : `:${finding.startLine}`;
};

/**
 * What the agent is told about a finding: its severity and title, where it
 * is, what the reviewer wrote and how it knows. Markdown. `note` is what a
 * person added when they sent it.
 */
export const findingInstructionBody = (
  finding: Pick<
    FindingRow,
    | "severity"
    | "title"
    | "body"
    | "path"
    | "startLine"
    | "endLine"
    | "evidence"
    | "reviewerKind"
    | "lastSeenVersionNumber"
  >,
  note?: string | undefined,
): string => {
  const severity = { must_fix: "Must fix", should_fix: "Should fix", note: "Note" }[
    finding.severity
  ];
  const parts = [`**${severity}: ${finding.title}**`];
  if (finding.path !== null) {
    parts.push(
      `\`${finding.path}${lineRange(finding)}\` (version ${finding.lastSeenVersionNumber})`,
    );
  }
  if (finding.body.trim() !== "") parts.push(finding.body.trim());
  for (const evidence of finding.evidence) {
    const fence = evidence.text.includes("```") ? "````" : "```";
    parts.push(
      `Evidence (${evidence.kind})${evidence.url ? `, ${evidence.url}` : ""}:\n${fence}\n${evidence.text}\n${fence}`,
    );
  }
  parts.push(`Found by the ${finding.reviewerKind} reviewer.`);
  if (note !== undefined && note.trim() !== "") parts.push(note.trim());
  return parts.join("\n\n");
};

/**
 * Queue an instruction for each of these findings that is open and not
 * already with the agent or on its way (queued or delivered).
 * `createdByUserId` is null when the forge sends it on its own. Answers the
 * rows written.
 *
 * Safe to repeat: a second call for the same findings writes nothing.
 */
export const queueFindingInstructions = async (input: {
  readonly repositoryId: string;
  readonly pullRequestId: string;
  readonly findings: readonly FindingRow[];
  readonly createdByUserId: string | null;
  readonly note?: string | undefined;
}): Promise<InstructionRow[]> => {
  const findings = input.findings.filter((finding) => finding.status === "open");
  if (findings.length === 0) return [];
  const out = await db
    .select({ findingId: gitInstructions.findingId })
    .from(gitInstructions)
    .where(
      and(
        eq(gitInstructions.pullRequestId, input.pullRequestId),
        inArray(
          gitInstructions.findingId,
          findings.map((finding) => finding.id),
        ),
        inArray(gitInstructions.status, ["queued", "delivered"]),
      ),
    );
  const withAgent = new Set(out.map((row) => row.findingId));
  const rows = findings
    .filter((finding) => !withAgent.has(finding.id))
    .map((finding) => ({
      id: newId(),
      repositoryId: input.repositoryId,
      pullRequestId: input.pullRequestId,
      source: "finding" as const,
      findingId: finding.id,
      body: findingInstructionBody(finding, input.note),
      createdByUserId: input.createdByUserId,
      status: "queued" as const,
    }));
  if (rows.length === 0) return [];
  return db.insert(gitInstructions).values(rows).returning();
};

/** Whether a pull request names the agent that writes its branch. */
const hasAgentLink = async (pullRequestId: string): Promise<boolean> => {
  const [row] = await db
    .select({ pullRequestId: gitAgentLinks.pullRequestId })
    .from(gitAgentLinks)
    .where(eq(gitAgentLinks.pullRequestId, pullRequestId))
    .limit(1);
  return row !== undefined;
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
  if (!(await hasAgentLink(target.pullRequestId))) return 0;
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
