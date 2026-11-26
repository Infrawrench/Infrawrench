/**
 * What review agents found, the runs that found it, and the overrides that
 * let a merge past it (`git_review_findings`, `git_review_runs`,
 * `git_merge_overrides`).
 *
 * A finding is one row for the life of its pull request, carried from version
 * to version by `fingerprint` (unique per pull request). Writing one that is
 * already there updates it, reopens it when it was fixed, and leaves it alone
 * when a person dismissed it: that is how a dismissal is remembered.
 *
 * A run is leased by `started_at`: a delivery claims a run that is queued, or
 * one that has been running longer than the lease (its invocation died), so
 * no row stays `running` for ever and two deliveries never run one at once.
 */
import { and, asc, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import {
  type GitDiffSide,
  type GitFindingEvidence,
  type GitFindingSeverity,
  type GitFindingStatus,
  type GitReviewRunStatus,
  gitMergeOverrides,
  gitReviewFindings,
  gitReviewRuns,
  gitTraceEntries,
} from "@infrawrench/server-core/db/schema";
import { db, newId } from "./client";
import type { VersionRow } from "./review";

export type FindingRow = typeof gitReviewFindings.$inferSelect;
export type ReviewRunRow = typeof gitReviewRuns.$inferSelect;
export type MergeOverrideRow = typeof gitMergeOverrides.$inferSelect;

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface ListFindingsOptions {
  /** Only findings seen on this version: raised at or before it and still found on it. */
  readonly version?: number | undefined;
  readonly status?: GitFindingStatus | undefined;
  readonly reviewerKind?: string | undefined;
}

/** A pull request's findings, in file then line order; those about the whole change first. */
export const listFindings = (
  pullRequestId: string,
  options: ListFindingsOptions = {},
): Promise<FindingRow[]> =>
  db
    .select()
    .from(gitReviewFindings)
    .where(
      and(
        eq(gitReviewFindings.pullRequestId, pullRequestId),
        options.status ? eq(gitReviewFindings.status, options.status) : undefined,
        options.reviewerKind ? eq(gitReviewFindings.reviewerKind, options.reviewerKind) : undefined,
        options.version === undefined
          ? undefined
          : sql`${gitReviewFindings.versionNumber} <= ${options.version} and ${gitReviewFindings.lastSeenVersionNumber} >= ${options.version}`,
      ),
    )
    .orderBy(
      sql`${gitReviewFindings.path} asc nulls first`,
      sql`${gitReviewFindings.startLine} asc nulls first`,
      asc(gitReviewFindings.createdAt),
      asc(gitReviewFindings.id),
    );

export const getFinding = async (
  pullRequestId: string,
  findingId: string,
): Promise<FindingRow | null> => {
  const [row] = await db
    .select()
    .from(gitReviewFindings)
    .where(
      and(eq(gitReviewFindings.id, findingId), eq(gitReviewFindings.pullRequestId, pullRequestId)),
    )
    .limit(1);
  return row ?? null;
};

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

/** An open finding is still there on a version, possibly on other lines. */
export const confirmFinding = async (
  findingId: string,
  version: Pick<VersionRow, "number" | "tipOid">,
  anchor: {
    readonly path: string | null;
    readonly startLine: number | null;
    readonly endLine: number | null;
  } | null,
): Promise<void> => {
  await db
    .update(gitReviewFindings)
    .set({
      lastSeenVersionNumber: version.number,
      ...(anchor ? { ...anchor, commitOid: version.tipOid } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(gitReviewFindings.id, findingId),
        eq(gitReviewFindings.status, "open"),
        sql`${gitReviewFindings.lastSeenVersionNumber} <= ${version.number}`,
      ),
    );
};

/** Open findings are fixed in a version: only ones last seen before it. */
export const markFindingsFixed = async (
  findingIds: readonly string[],
  versionNumber: number,
): Promise<FindingRow[]> => {
  if (findingIds.length === 0) return [];
  return db
    .update(gitReviewFindings)
    .set({ status: "fixed", fixedInVersionNumber: versionNumber, updatedAt: new Date() })
    .where(
      and(
        inArray(gitReviewFindings.id, [...findingIds]),
        eq(gitReviewFindings.status, "open"),
        sql`${gitReviewFindings.lastSeenVersionNumber} < ${versionNumber}`,
      ),
    )
    .returning();
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

/** Dismiss an open finding. Null when it was not open. */
export const dismissFinding = async (
  findingId: string,
  userId: string | null,
  reason: string,
): Promise<FindingRow | null> => {
  const now = new Date();
  const [row] = await db
    .update(gitReviewFindings)
    .set({
      status: "dismissed",
      dismissedByUserId: userId,
      dismissedAt: now,
      dismissalReason: reason,
      updatedAt: now,
    })
    .where(and(eq(gitReviewFindings.id, findingId), eq(gitReviewFindings.status, "open")))
    .returning();
  return row ?? null;
};

/** Reopen a dismissed finding. Null when it was not dismissed. */
export const reopenFinding = async (findingId: string): Promise<FindingRow | null> => {
  const [row] = await db
    .update(gitReviewFindings)
    .set({
      status: "open",
      dismissedByUserId: null,
      dismissedAt: null,
      dismissalReason: null,
      updatedAt: new Date(),
    })
    .where(and(eq(gitReviewFindings.id, findingId), eq(gitReviewFindings.status, "dismissed")))
    .returning();
  return row ?? null;
};

/** How many findings each of these runs wrote last, by run id. */
export const findingCountsByRun = async (
  runIds: readonly string[],
): Promise<Map<string, number>> => {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select({ runId: gitReviewFindings.runId, count: sql<number>`count(*)::int` })
    .from(gitReviewFindings)
    .where(inArray(gitReviewFindings.runId, [...runIds]))
    .groupBy(gitReviewFindings.runId);
  return new Map(rows.flatMap((row) => (row.runId ? [[row.runId, row.count] as const] : [])));
};

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export const insertMergeOverride = async (override: {
  readonly repositoryId: string;
  readonly pullRequestId: string;
  readonly userId: string | null;
  readonly reason: string;
  readonly findingIds: readonly string[];
  readonly headOid: string;
}): Promise<MergeOverrideRow> => {
  const [row] = await db
    .insert(gitMergeOverrides)
    .values({ id: newId(), ...override, findingIds: [...override.findingIds] })
    .returning();
  return row!;
};

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** A pull request's runs, newest first. */
export const listReviewRuns = (pullRequestId: string, limit = 100): Promise<ReviewRunRow[]> =>
  db
    .select()
    .from(gitReviewRuns)
    .where(eq(gitReviewRuns.pullRequestId, pullRequestId))
    .orderBy(desc(gitReviewRuns.createdAt), desc(gitReviewRuns.id))
    .limit(limit);

export const getReviewRun = async (
  pullRequestId: string,
  runId: string,
): Promise<ReviewRunRow | null> => {
  const [row] = await db
    .select()
    .from(gitReviewRuns)
    .where(and(eq(gitReviewRuns.id, runId), eq(gitReviewRuns.pullRequestId, pullRequestId)))
    .limit(1);
  return row ?? null;
};

export const getReviewRunById = async (runId: string): Promise<ReviewRunRow | null> => {
  const [row] = await db.select().from(gitReviewRuns).where(eq(gitReviewRuns.id, runId)).limit(1);
  return row ?? null;
};

export interface NewReviewRun {
  readonly repositoryId: string;
  readonly pullRequestId: string;
  readonly version: Pick<VersionRow, "id" | "number" | "tipOid">;
  readonly reviewerKinds: readonly string[];
  readonly trigger: "push" | "manual";
  readonly requestedByUserId: string | null;
}

const ACTIVE: GitReviewRunStatus[] = ["queued", "running"];

/** One pull request's runs are queued one at a time: the lock two deliveries of a push meet at. */
const lockPull = (tx: Pick<typeof db, "execute">, pullRequestId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`git_review:${pullRequestId}`}))`);

/**
 * Queue the run a new version starts. Null when this version already has a
 * run a push started (a second delivery, or a version copied twice). Runs an
 * older version's push queued and nothing has picked up yet are removed: the
 * newer version is the one worth reviewing.
 */
export const queuePushRun = (run: Omit<NewReviewRun, "trigger">): Promise<ReviewRunRow | null> =>
  db.transaction(async (tx) => {
    await lockPull(tx, run.pullRequestId);
    const [seen] = await tx
      .select({ id: gitReviewRuns.id })
      .from(gitReviewRuns)
      .where(
        and(
          eq(gitReviewRuns.pullRequestId, run.pullRequestId),
          eq(gitReviewRuns.versionId, run.version.id),
          eq(gitReviewRuns.trigger, "push"),
        ),
      )
      .limit(1);
    if (seen) return null;
    await tx
      .delete(gitReviewRuns)
      .where(
        and(
          eq(gitReviewRuns.pullRequestId, run.pullRequestId),
          eq(gitReviewRuns.status, "queued"),
          eq(gitReviewRuns.trigger, "push"),
        ),
      );
    const [row] = await tx
      .insert(gitReviewRuns)
      .values({
        id: newId(),
        repositoryId: run.repositoryId,
        pullRequestId: run.pullRequestId,
        versionId: run.version.id,
        versionNumber: run.version.number,
        headOid: run.version.tipOid,
        reviewerKinds: [...run.reviewerKinds],
        trigger: "push",
        requestedByUserId: run.requestedByUserId,
      })
      .returning();
    return row!;
  });

/** Queue a run somebody asked for. Null when a run of the same version is already queued or running. */
export const queueManualRun = (run: Omit<NewReviewRun, "trigger">): Promise<ReviewRunRow | null> =>
  db.transaction(async (tx) => {
    await lockPull(tx, run.pullRequestId);
    const [active] = await tx
      .select({ id: gitReviewRuns.id })
      .from(gitReviewRuns)
      .where(
        and(
          eq(gitReviewRuns.pullRequestId, run.pullRequestId),
          eq(gitReviewRuns.versionId, run.version.id),
          inArray(gitReviewRuns.status, ACTIVE),
        ),
      )
      .limit(1);
    if (active) return null;
    const [row] = await tx
      .insert(gitReviewRuns)
      .values({
        id: newId(),
        repositoryId: run.repositoryId,
        pullRequestId: run.pullRequestId,
        versionId: run.version.id,
        versionNumber: run.version.number,
        headOid: run.version.tipOid,
        reviewerKinds: [...run.reviewerKinds],
        trigger: "manual",
        requestedByUserId: run.requestedByUserId,
      })
      .returning();
    return row!;
  });

/**
 * Take a run to work on it: one that is queued, or one whose last holder
 * started more than `leaseMs` ago and never finished. Null when it is
 * finished, gone, or held by somebody still inside the lease.
 */
export const claimReviewRun = async (
  runId: string,
  now: Date,
  leaseMs: number,
): Promise<ReviewRunRow | null> => {
  const [row] = await db
    .update(gitReviewRuns)
    .set({ status: "running", startedAt: now, finishedAt: null, error: null })
    .where(
      and(
        eq(gitReviewRuns.id, runId),
        or(
          eq(gitReviewRuns.status, "queued"),
          and(
            eq(gitReviewRuns.status, "running"),
            lt(gitReviewRuns.startedAt, new Date(now.getTime() - leaseMs)),
          ),
        ),
      ),
    )
    .returning();
  return row ?? null;
};

/** Add what a reviewer spent to its run. */
export const addRunUsage = async (
  runId: string,
  usage: {
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicros: number;
  },
): Promise<void> => {
  await db
    .update(gitReviewRuns)
    .set({
      model: usage.model,
      inputTokens: sql`${gitReviewRuns.inputTokens} + ${Math.round(usage.inputTokens)}`,
      outputTokens: sql`${gitReviewRuns.outputTokens} + ${Math.round(usage.outputTokens)}`,
      costMicros: sql`${gitReviewRuns.costMicros} + ${Math.round(usage.costMicros)}`,
    })
    .where(eq(gitReviewRuns.id, runId));
};

/** End a run that is queued or running. Null when it had ended already. */
export const finishReviewRun = async (
  runId: string,
  outcome: { readonly status: "done" | "failed"; readonly error: string | null },
  now: Date = new Date(),
): Promise<ReviewRunRow | null> => {
  const [row] = await db
    .update(gitReviewRuns)
    .set({ status: outcome.status, error: outcome.error, finishedAt: now })
    .where(and(eq(gitReviewRuns.id, runId), inArray(gitReviewRuns.status, ACTIVE)))
    .returning();
  return row ?? null;
};

/** Give a claimed run back, so the next delivery can take it without waiting out the lease. */
export const releaseReviewRun = async (runId: string): Promise<void> => {
  await db
    .update(gitReviewRuns)
    .set({ status: "queued", startedAt: null })
    .where(and(eq(gitReviewRuns.id, runId), eq(gitReviewRuns.status, "running")));
};

/** What a reviewer outside the forge says of its run. */
export const updateExternalRun = async (
  runId: string,
  patch: {
    readonly status?: GitReviewRunStatus | undefined;
    readonly model?: string | null | undefined;
    readonly inputTokens?: number | undefined;
    readonly outputTokens?: number | undefined;
    readonly costMicros?: number | undefined;
    readonly error?: string | null | undefined;
  },
  now: Date = new Date(),
): Promise<ReviewRunRow | null> => {
  const ended = patch.status === "done" || patch.status === "failed";
  const [row] = await db
    .update(gitReviewRuns)
    .set({
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.status === "running"
        ? { startedAt: sql`coalesce(${gitReviewRuns.startedAt}, now())` }
        : {}),
      ...(ended ? { finishedAt: now } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.inputTokens !== undefined ? { inputTokens: patch.inputTokens } : {}),
      ...(patch.outputTokens !== undefined ? { outputTokens: patch.outputTokens } : {}),
      ...(patch.costMicros !== undefined ? { costMicros: patch.costMicros } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
    })
    .where(eq(gitReviewRuns.id, runId))
    .returning();
  return row ?? null;
};

/** Runs that are queued or running and were made before `before`, oldest first. */
export const activeRunsBefore = (before: Date, limit: number): Promise<ReviewRunRow[]> =>
  db
    .select()
    .from(gitReviewRuns)
    .where(and(inArray(gitReviewRuns.status, ACTIVE), lt(gitReviewRuns.createdAt, before)))
    .orderBy(asc(gitReviewRuns.createdAt))
    .limit(limit);

// ---------------------------------------------------------------------------
// What a reviewer reads besides the code
// ---------------------------------------------------------------------------

/** What the authoring agent recorded for a version, oldest first. */
export const traceEntriesOfVersion = (
  versionId: string,
  limit: number,
): Promise<Array<typeof gitTraceEntries.$inferSelect>> =>
  db
    .select()
    .from(gitTraceEntries)
    .where(eq(gitTraceEntries.versionId, versionId))
    .orderBy(asc(gitTraceEntries.createdAt), asc(gitTraceEntries.id))
    .limit(limit);

export const traceEntryCount = async (versionId: string): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(gitTraceEntries)
    .where(eq(gitTraceEntries.versionId, versionId));
  return row?.count ?? 0;
};
