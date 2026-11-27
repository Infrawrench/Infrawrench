/**
 * Trace entries' rows (`git_trace_entries`) as they are written, by the
 * forge's `traces.record` and by a CI job's note commands
 * (`ci/git-notes.ts`). What goes into a row has already been masked
 * (`./trace.ts`).
 */
import { db } from "../db/client.js";
import { type GitAgentIdentity, gitTraceEntries } from "../db/schema.js";
import type { PreparedTraceEntry } from "./trace.js";

export type TraceEntryRow = typeof gitTraceEntries.$inferSelect;

const newId = (): string => crypto.randomUUID();

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
  /**
   * The version the entries are of, for a writer that knows it (CI, whose
   * run is of one commit). Left out, they wait for the branch's next push.
   */
  readonly versionId?: string | null;
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
        versionId: input.versionId ?? null,
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
