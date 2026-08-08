/**
 * Reads and deletes over recorded SSH sessions.
 *
 * The write side lives in `recorder.ts` and is subordinate to the terminal;
 * this side is ordinary request-time work and is allowed to throw.
 */
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { gunzipSync } from "node:zlib";

import { db } from "../db/client";
import { sshSessionRecordingChunks, sshSessionRecordings } from "../db/schema";

/**
 * How long a row may sit at `"recording"` past its last chunk before the list
 * view calls it abandoned.
 *
 * A session whose web replica was killed never gets its closing write, and a
 * row left saying "recording" forever is worse than useless — it is a live
 * session that is not live. Two minutes is well clear of the recorder's 5s
 * flush interval, so a session that is still flushing chunks is never
 * mislabelled. Purely idle shells (no I/O, so no new chunks) can look
 * abandoned until the next keystroke or until `finish` settles them.
 */
const ABANDONED_AFTER_MS = 2 * 60 * 1000;

/**
 * Latest chunk write for a parent row — the true last-activity signal.
 *
 * Built on demand rather than at module load so suites that partial-mock
 * `drizzle-orm` (and never call list/get) do not trip over a missing `sql`
 * export during import.
 */
function lastChunkAtSql() {
  return sql<Date | null>`(
    select max(${sshSessionRecordingChunks.createdAt})
    from ${sshSessionRecordingChunks}
    where ${sshSessionRecordingChunks.recordingId} = ${sshSessionRecordings.id}
  )`;
}

export type SessionRecordingStatus = "recording" | "complete" | "truncated" | "abandoned";

/** One recording as the list and detail views see it. */
export interface SessionRecordingSummary {
  id: string;
  userId: string | null;
  userName: string | null;
  accountId: string | null;
  resourceId: string | null;
  host: string;
  port: number;
  username: string;
  hopCount: number;
  cols: number;
  rows: number;
  hasInput: boolean;
  status: SessionRecordingStatus;
  outputBytes: number;
  eventCount: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

export interface ListSessionRecordingsOptions {
  userId?: string;
  resourceId?: string;
  accountId?: string;
  status?: SessionRecordingStatus;
  /** Inclusive ISO instant lower bound on `startedAt`. */
  since?: Date;
  /** Exclusive ISO instant upper bound on `startedAt`. */
  until?: Date;
  limit?: number;
}

/**
 * Present a row, settling a stale `"recording"` into `"abandoned"`.
 *
 * Derived rather than written back on the list path: a sweep that rewrote the
 * column would race the recorder's own closing update on a session that was
 * merely idle. Last activity is the latest chunk write when known — never the
 * session start alone, or a multi-hour live session would look abandoned.
 */
function toSummary(
  row: typeof sshSessionRecordings.$inferSelect,
  now: number,
  lastChunkAt?: Date | null,
): SessionRecordingSummary {
  let status = row.status as SessionRecordingStatus;
  if (status === "recording") {
    const lastActivity = (lastChunkAt ?? row.endedAt ?? row.startedAt).getTime();
    if (now - lastActivity > ABANDONED_AFTER_MS) status = "abandoned";
  }
  return {
    id: row.id,
    userId: row.userId,
    userName: row.userName,
    accountId: row.accountId,
    resourceId: row.resourceId,
    host: row.host,
    port: row.port,
    username: row.username,
    hopCount: row.hopCount,
    cols: row.cols,
    rows: row.rows,
    hasInput: row.hasInput,
    status,
    outputBytes: row.outputBytes,
    eventCount: row.eventCount,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    durationMs: row.durationMs,
  };
}

/** An org's recordings, newest first. */
export async function listSessionRecordings(
  organizationId: string,
  opts: ListSessionRecordingsOptions = {},
): Promise<SessionRecordingSummary[]> {
  const conditions = [eq(sshSessionRecordings.organizationId, organizationId)];
  if (opts.userId) conditions.push(eq(sshSessionRecordings.userId, opts.userId));
  if (opts.resourceId) conditions.push(eq(sshSessionRecordings.resourceId, opts.resourceId));
  if (opts.accountId) conditions.push(eq(sshSessionRecordings.accountId, opts.accountId));
  if (opts.since) conditions.push(gte(sshSessionRecordings.startedAt, opts.since));
  if (opts.until) conditions.push(lt(sshSessionRecordings.startedAt, opts.until));
  // `abandoned` is derived, so it can only be filtered after presentation.
  if (opts.status && opts.status !== "abandoned") {
    conditions.push(eq(sshSessionRecordings.status, opts.status));
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      row: sshSessionRecordings,
      lastChunkAt: lastChunkAtSql(),
    })
    .from(sshSessionRecordings)
    .where(and(...conditions))
    .orderBy(desc(sshSessionRecordings.startedAt))
    // `abandoned` and `recording` come from the same stored value, so a filter
    // on either has to over-fetch and narrow below or it would short the page.
    .limit(opts.status === "abandoned" || opts.status === "recording" ? limit * 4 : limit);

  const now = Date.now();
  const summaries = rows.map((r) => toSummary(r.row, now, coerceDate(r.lastChunkAt)));
  const filtered = opts.status ? summaries.filter((s) => s.status === opts.status) : summaries;
  return filtered.slice(0, limit);
}

export async function getSessionRecording(
  organizationId: string,
  recordingId: string,
): Promise<SessionRecordingSummary | null> {
  const [hit] = await db
    .select({
      row: sshSessionRecordings,
      lastChunkAt: lastChunkAtSql(),
    })
    .from(sshSessionRecordings)
    .where(
      and(
        eq(sshSessionRecordings.id, recordingId),
        eq(sshSessionRecordings.organizationId, organizationId),
      ),
    )
    .limit(1);
  return hit ? toSummary(hit.row, Date.now(), coerceDate(hit.lastChunkAt)) : null;
}

function coerceDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Reassemble the `.cast` document for one recording.
 *
 * Chunks are immutable and `seq`-ordered, so this is a concatenation, not a
 * merge. A chunk that fails to decompress is skipped with a log rather than
 * failing the download: `parseCast` already tolerates a missing frame, and a
 * recording with a hole in the middle is still evidence of everything either
 * side of the hole.
 */
export async function readSessionRecordingCast(
  organizationId: string,
  recordingId: string,
): Promise<string | null> {
  const summary = await getSessionRecording(organizationId, recordingId);
  if (!summary) return null;

  const chunks = await db
    .select({
      seq: sshSessionRecordingChunks.seq,
      payload: sshSessionRecordingChunks.payload,
    })
    .from(sshSessionRecordingChunks)
    .where(
      and(
        eq(sshSessionRecordingChunks.recordingId, recordingId),
        eq(sshSessionRecordingChunks.organizationId, organizationId),
      ),
    )
    .orderBy(asc(sshSessionRecordingChunks.seq));

  const parts: string[] = [];
  for (const chunk of chunks) {
    try {
      parts.push(gunzipSync(Buffer.from(chunk.payload, "base64")).toString("utf8"));
    } catch (err) {
      console.error(
        `[ssh-recording] ${recordingId}: chunk ${chunk.seq} could not be decompressed; skipping:`,
        err,
      );
    }
  }
  return parts.join("");
}

/**
 * A filename an operator can drop straight into a ticket:
 * `ssh-2026-08-07T09-14-22Z-root-at-10-0-0-4.cast`.
 */
export function sessionRecordingFilename(summary: SessionRecordingSummary): string {
  const stamp = summary.startedAt.replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const who = `${summary.username}-at-${summary.host}`.replace(/[^A-Za-z0-9._-]/g, "-");
  return `ssh-${stamp}-${who}.cast`;
}

/** Delete one recording and its tape. Returns false when it was not there. */
export async function deleteSessionRecording(
  organizationId: string,
  recordingId: string,
): Promise<boolean> {
  // Chunks cascade from the parent row, but deleting them first keeps the
  // window where a download could read a body whose index row is already gone.
  await db
    .delete(sshSessionRecordingChunks)
    .where(
      and(
        eq(sshSessionRecordingChunks.recordingId, recordingId),
        eq(sshSessionRecordingChunks.organizationId, organizationId),
      ),
    );
  const deleted = await db
    .delete(sshSessionRecordings)
    .where(
      and(
        eq(sshSessionRecordings.id, recordingId),
        eq(sshSessionRecordings.organizationId, organizationId),
      ),
    )
    .returning({ id: sshSessionRecordings.id });
  return deleted.length > 0;
}

/** Totals for the settings header ("142 recordings, 38 MB, oldest 12 Jun"). */
export interface SessionRecordingUsage {
  recordingCount: number;
  /** Stored (compressed, base64) size in bytes — what the org actually costs us. */
  storedBytes: number;
  /** Captured terminal bytes before compression. */
  capturedBytes: number;
  oldestStartedAt: string | null;
}

export async function getSessionRecordingUsage(
  organizationId: string,
): Promise<SessionRecordingUsage> {
  const [counts] = await db
    .select({
      recordingCount: sql<number>`count(*)::int`,
      capturedBytes: sql<number>`coalesce(sum(${sshSessionRecordings.outputBytes}), 0)::bigint`,
      oldestStartedAt: sql<Date | null>`min(${sshSessionRecordings.startedAt})`,
    })
    .from(sshSessionRecordings)
    .where(eq(sshSessionRecordings.organizationId, organizationId));

  const [stored] = await db
    .select({
      storedBytes: sql<number>`coalesce(sum(length(${sshSessionRecordingChunks.payload})), 0)::bigint`,
    })
    .from(sshSessionRecordingChunks)
    .where(eq(sshSessionRecordingChunks.organizationId, organizationId));

  const oldest = counts?.oldestStartedAt ? new Date(counts.oldestStartedAt) : null;
  return {
    recordingCount: Number(counts?.recordingCount ?? 0),
    storedBytes: Number(stored?.storedBytes ?? 0),
    capturedBytes: Number(counts?.capturedBytes ?? 0),
    oldestStartedAt: oldest && !Number.isNaN(oldest.getTime()) ? oldest.toISOString() : null,
  };
}

/**
 * Delete one org's recordings that started before `cutoff`. Used by the
 * retention pass; batched so a first prune of a long-neglected org cannot hold
 * locks for minutes. Returns how many index rows went.
 *
 * Never deletes `status = 'recording'`: an open shell can outlive the retention
 * window, and removing its row mid-stream strands the writer and loses the
 * tape. Abandoned/complete/truncated rows are the only ones due; the settle
 * pass closes dead `"recording"` rows first.
 */
export async function pruneOrgSessionRecordings(
  organizationId: string,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  const due = await db
    .select({ id: sshSessionRecordings.id })
    .from(sshSessionRecordings)
    .where(
      and(
        eq(sshSessionRecordings.organizationId, organizationId),
        lt(sshSessionRecordings.startedAt, cutoff),
        ne(sshSessionRecordings.status, "recording"),
      ),
    )
    .orderBy(asc(sshSessionRecordings.startedAt))
    .limit(batchSize);
  if (due.length === 0) return 0;

  const ids = due.map((r) => r.id);
  await db
    .delete(sshSessionRecordingChunks)
    .where(inArray(sshSessionRecordingChunks.recordingId, ids));
  const deleted = await db
    .delete(sshSessionRecordings)
    .where(inArray(sshSessionRecordings.id, ids))
    .returning({ id: sshSessionRecordings.id });
  return deleted.length;
}
