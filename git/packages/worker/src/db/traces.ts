/**
 * Trace entries' rows (`git_trace_entries`): what an agent recorded while it
 * worked. An entry is written to a branch with no version; the next push to
 * the branch claims it (`db/review.ts` `claimTraceEntries`). What goes into
 * a row has already been masked (`review/trace.ts`).
 */
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  type GitAgentIdentity,
  gitBranchVersions,
  gitTraceEntries,
} from "@infrawrench/server-core/db/schema";
import type { PreparedTraceEntry } from "../review/trace";
import { db, newId } from "./client";
import { type PageOf, type TimeCursor, afterCursor, cursorTime, toPage } from "./cursor";

export type TraceEntryRow = typeof gitTraceEntries.$inferSelect;

/** How many entries are waiting for a push: on one branch, and on all of the repository's. */
export const pendingTraceCounts = async (
  repositoryId: string,
  branch: string,
): Promise<{ readonly branch: number; readonly repository: number }> => {
  const [row] = await db
    .select({
      branch: sql<number>`count(*) filter (where ${gitTraceEntries.branch} = ${branch})::int`,
      repository: sql<number>`count(*)::int`,
    })
    .from(gitTraceEntries)
    .where(and(eq(gitTraceEntries.repositoryId, repositoryId), isNull(gitTraceEntries.versionId)));
  return { branch: row?.branch ?? 0, repository: row?.repository ?? 0 };
};

/**
 * Insert a call's entries, in the order they were given. They are spaced a
 * millisecond apart ending at the call's own time, so "oldest first" is the
 * order the agent wrote them in whatever their ids sort like, and none is
 * dated after the call: a push that follows at once claims them all
 * (`claimTraceEntries` takes what was written at or before the push).
 */
export const insertTraceEntries = async (input: {
  readonly repositoryId: string;
  readonly branch: string;
  readonly authorUserId: string | null;
  readonly agent: GitAgentIdentity | null;
  readonly entries: readonly PreparedTraceEntry[];
  readonly now?: Date;
}): Promise<TraceEntryRow[]> => {
  if (input.entries.length === 0) return [];
  const base = (input.now ?? new Date()).getTime();
  const rows = await db
    .insert(gitTraceEntries)
    .values(
      input.entries.map((entry, index) => ({
        id: newId(),
        repositoryId: input.repositoryId,
        branch: input.branch,
        kind: entry.kind,
        body: entry.body,
        anchors: entry.anchors,
        needsCode: entry.needsCode,
        evidence: entry.evidence,
        authorUserId: input.authorUserId,
        agent: input.agent,
        // A millisecond apart: cursors compare to the millisecond (`cursor.ts`).
        createdAt: new Date(base - (input.entries.length - 1 - index)),
      })),
    )
    .returning();
  const order = new Map(rows.map((row) => [row.id, row] as const));
  return [...order.values()].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
};

export interface TraceScope {
  /** Entries a push has claimed: those of these versions. */
  readonly versionIds: readonly string[];
  /** Entries still waiting: those written to this branch of this repository. Null for none. */
  readonly pending: { readonly repositoryId: string; readonly branch: string } | null;
}

/** A page of a branch's trace, oldest first. */
export const listTraceEntries = async (
  scope: TraceScope,
  options: { readonly cursor: TimeCursor | null; readonly limit: number },
): Promise<PageOf<TraceEntryRow>> => {
  const claimed =
    scope.versionIds.length > 0
      ? inArray(gitTraceEntries.versionId, [...scope.versionIds])
      : undefined;
  const waiting = scope.pending
    ? and(
        eq(gitTraceEntries.repositoryId, scope.pending.repositoryId),
        eq(gitTraceEntries.branch, scope.pending.branch),
        isNull(gitTraceEntries.versionId),
      )
    : undefined;
  if (claimed === undefined && waiting === undefined) return { items: [], nextCursor: null };
  const rows = await db
    .select()
    .from(gitTraceEntries)
    .where(
      and(
        or(claimed, waiting),
        afterCursor(gitTraceEntries.createdAt, gitTraceEntries.id, options.cursor, "asc"),
      ),
    )
    .orderBy(asc(cursorTime(gitTraceEntries.createdAt)), asc(gitTraceEntries.id))
    .limit(options.limit + 1);
  return toPage(rows, options.limit, (row) => ({ at: row.createdAt.getTime(), id: row.id }));
};

/** The number of each version in `ids`, by its id. */
export const versionNumbersById = async (ids: readonly string[]): Promise<Map<string, number>> => {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: gitBranchVersions.id, number: gitBranchVersions.number })
    .from(gitBranchVersions)
    .where(inArray(gitBranchVersions.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.number] as const));
};

/** A branch's versions in this repository, of its newest lineage, oldest first. */
export const versionsOfBranch = async (
  repositoryId: string,
  branch: string,
): Promise<Array<typeof gitBranchVersions.$inferSelect>> => {
  const rows = await db
    .select()
    .from(gitBranchVersions)
    .where(
      and(eq(gitBranchVersions.repositoryId, repositoryId), eq(gitBranchVersions.branch, branch)),
    )
    .orderBy(asc(gitBranchVersions.lineage), asc(gitBranchVersions.number));
  const lineage = rows.at(-1)?.lineage;
  return rows.filter((row) => row.lineage === lineage);
};

/**
 * Drop entries that waited too long for a push: written to a branch that was
 * never pushed, or never pushed again. Answers how many went.
 */
export const deleteStalePendingTraces = async (before: Date, limit = 5000): Promise<number> => {
  const stale = db
    .select({ id: gitTraceEntries.id })
    .from(gitTraceEntries)
    .where(and(isNull(gitTraceEntries.versionId), lt(gitTraceEntries.createdAt, before)))
    .limit(limit);
  const deleted = await db
    .delete(gitTraceEntries)
    .where(inArray(gitTraceEntries.id, stale))
    .returning({ id: gitTraceEntries.id });
  return deleted.length;
};
