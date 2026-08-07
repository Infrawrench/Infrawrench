/**
 * The live tee: turns one cloud-proxied SSH session into an asciicast.
 *
 * The SSH proxy already sees every byte in both directions, so recording is a
 * second consumer of a stream we hold rather than anything installed on the
 * customer's host. That is the whole economics of this feature — and it is
 * also why the recorder must be *completely* subordinate to the session: an
 * operator's terminal must never stall, hiccup or fail because a write to
 * `ssh_session_recording_chunks` did.
 *
 * Three rules follow from that, and every design decision below is one of them:
 *
 * 1. **Nothing throws.** Every entry point swallows its own errors and logs.
 *    A recorder that has failed simply stops recording (`disabled`), and the
 *    session carries on none the wiser.
 * 2. **Memory is bounded.** Events buffer to a chunk and flush; a session
 *    streaming a gigabyte of logs holds a chunk, not a gigabyte.
 * 3. **Writes are serialized and never awaited by the data path.** `onOutput`
 *    is called from an ssh2 `"data"` handler; it appends to a buffer and
 *    returns. Flushes chain off a single promise so chunk `seq` is ordered
 *    without a lock.
 */
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import { and, eq } from "drizzle-orm";

import { db } from "../db/client";
import { sshSessionRecordingChunks, sshSessionRecordings, users } from "../db/schema";

import { encodeCastEvent, encodeCastHeader, encodeResizeData } from "./cast";
import { getCachedSessionRecordingSettings } from "./settings";

/**
 * Buffered event bytes that trigger a flush.
 *
 * 64 KiB is roughly a screenful of a busy TUI's redraws. Smaller would write a
 * row per keystroke burst; larger would lose more of a session to a proxy that
 * dies mid-stream, since anything still buffered when the process goes is gone.
 */
const CHUNK_FLUSH_BYTES = 64 * 1024;

/**
 * Longest a partial chunk sits unwritten.
 *
 * Bounds how much a crash can lose on an *idle* session, which the byte
 * threshold alone never would: someone who opens a shell, runs one command and
 * leaves it open for an hour would otherwise have those first bytes sitting in
 * a buffer the whole time. It also makes a live session visible to the list
 * view within a few seconds of starting.
 */
const CHUNK_FLUSH_INTERVAL_MS = 5_000;

/**
 * Ceiling on captured terminal bytes per session, before compression.
 *
 * A session that `cat`s a multi-gigabyte log is not an audit artifact anybody
 * will watch, but it is an unbounded write amplifier against our database. At
 * the ceiling the recorder stops capturing and marks the row `"truncated"` —
 * an honest partial recording that says so, rather than either a silent gap or
 * an unbounded table. 32 MiB is about ten hours of ordinary interactive work.
 */
const MAX_SESSION_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Identity and shape of the session being recorded. */
export interface SessionRecordingContext {
  organizationId: string;
  /** Null for an API-key-authenticated socket, which has no human behind it. */
  userId?: string | undefined;
  accountId?: string | undefined;
  resourceId?: string | undefined;
  host: string;
  port?: number | undefined;
  username: string;
  /** Hops in the jump chain, 1 for a direct dial. */
  hopCount?: number | undefined;
  cols?: number | undefined;
  rows?: number | undefined;
}

/**
 * The tee handed to the proxy. Every method is fire-and-forget except
 * {@link SessionRecorder.finish}, which the proxy may await to make a
 * recording readable promptly after the terminal closes.
 */
export interface SessionRecorder {
  /** The `ssh_session_recordings.id` this is writing to. */
  readonly recordingId: string;
  /** Terminal output (and stderr) headed for the browser. */
  onOutput(data: Buffer | string): void;
  /** Keystrokes headed for the host. No-op unless the org opted into input capture. */
  onInput(data: Buffer | string): void;
  onResize(cols: number, rows: number): void;
  /** Flush the tail and settle the row. Safe to call more than once. */
  finish(): Promise<void>;
}

/**
 * Start recording, or return null when this session should not be recorded.
 *
 * Null covers every "not recording" case on purpose — the org opted out, the
 * settings read failed, the opening insert failed — so the proxy has exactly
 * one branch to write and no way to accidentally treat a broken recorder as a
 * working one.
 */
export async function startSessionRecording(
  ctx: SessionRecordingContext,
): Promise<SessionRecorder | null> {
  let captureInput = false;
  try {
    // Cached: an org with recording off — most orgs, most of the time — must
    // not pay a query on every SSH connect just to learn that.
    const settings = await getCachedSessionRecordingSettings(ctx.organizationId);
    if (!settings.enabled) return null;
    captureInput = settings.captureInput;
  } catch (err) {
    // Failing open here would record an org that never asked to be recorded.
    console.error(`[ssh-recording] settings read failed for org ${ctx.organizationId}:`, err);
    return null;
  }

  const recordingId = randomUUID();
  const startedAt = new Date();
  const cols = ctx.cols && ctx.cols > 0 ? Math.trunc(ctx.cols) : 80;
  const rows = ctx.rows && ctx.rows > 0 ? Math.trunc(ctx.rows) : 24;
  // Snapshotted here rather than joined at read time: a recording is evidence
  // about a person, and it has to still name them after they leave the org and
  // the `users` row goes. Only looked up once recording is known to be on, so
  // an org that never enabled this pays nothing for the column.
  const userName = ctx.userId ? await lookupUserName(ctx.userId) : null;

  try {
    await db.insert(sshSessionRecordings).values({
      id: recordingId,
      organizationId: ctx.organizationId,
      userId: ctx.userId ?? null,
      userName,
      accountId: ctx.accountId ?? null,
      resourceId: ctx.resourceId ?? null,
      host: ctx.host,
      port: ctx.port && ctx.port > 0 ? Math.trunc(ctx.port) : 22,
      username: ctx.username,
      hopCount: ctx.hopCount && ctx.hopCount > 0 ? Math.trunc(ctx.hopCount) : 1,
      cols,
      rows,
      hasInput: false,
      status: "recording",
      startedAt,
    });
  } catch (err) {
    console.error(`[ssh-recording] could not open recording for org ${ctx.organizationId}:`, err);
    return null;
  }

  return new ChunkedRecorder({
    recordingId,
    organizationId: ctx.organizationId,
    startedAtMs: startedAt.getTime(),
    captureInput,
    header: encodeCastHeader({
      width: cols,
      height: rows,
      timestamp: Math.floor(startedAt.getTime() / 1000),
      title: `${ctx.username}@${ctx.host}`,
      env: { TERM: "xterm-256color" },
    }),
  });
}

/** Display name for the recording row; null rather than throwing on failure. */
async function lookupUserName(userId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.displayName ?? row?.email ?? null;
  } catch (err) {
    console.error(`[ssh-recording] resolving the name of user ${userId} failed:`, err);
    return null;
  }
}

interface ChunkedRecorderInit {
  recordingId: string;
  organizationId: string;
  startedAtMs: number;
  captureInput: boolean;
  header: string;
}

class ChunkedRecorder implements SessionRecorder {
  readonly recordingId: string;

  private readonly organizationId: string;
  private readonly startedAtMs: number;
  private readonly captureInput: boolean;

  /** Event lines not yet written. The header rides along in chunk 0. */
  private buffer: string[];
  private bufferedBytes = 0;

  private seq = 0;
  private totalOutputBytes = 0;
  private totalEvents = 0;
  private sawInput = false;
  /** Set once the size ceiling is hit; the row settles as "truncated". */
  private truncated = false;
  /** Set when a write failed — recording stops, the session does not. */
  private disabled = false;
  private finished = false;

  /** Serializes chunk writes so `seq` is assigned in the order data arrived. */
  private writeChain: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(init: ChunkedRecorderInit) {
    this.recordingId = init.recordingId;
    this.organizationId = init.organizationId;
    this.startedAtMs = init.startedAtMs;
    this.captureInput = init.captureInput;
    this.buffer = [init.header];
    this.bufferedBytes = Buffer.byteLength(init.header, "utf8") + 1;
  }

  onOutput(data: Buffer | string): void {
    this.append("o", data, true);
  }

  onInput(data: Buffer | string): void {
    if (!this.captureInput) return;
    if (!this.sawInput) this.sawInput = true;
    this.append("i", data, false);
  }

  onResize(cols: number, rows: number): void {
    this.append("r", encodeResizeData(cols, rows), false);
  }

  /**
   * Buffer one event.
   *
   * `countsTowardCeiling` is true only for output: keystrokes and resizes are
   * a rounding error next to a `cat` of a log file, and dropping a session's
   * input events because its *output* filled the budget would make the
   * remaining tape misleading about who did what.
   */
  private append(code: "o" | "i" | "r", data: Buffer | string, countsTowardCeiling: boolean): void {
    if (this.disabled || this.finished) return;
    try {
      const text = typeof data === "string" ? data : data.toString("utf8");
      if (text.length === 0) return;
      if (countsTowardCeiling) {
        if (this.totalOutputBytes >= MAX_SESSION_OUTPUT_BYTES) {
          if (!this.truncated) {
            this.truncated = true;
            console.warn(
              `[ssh-recording] ${this.recordingId} hit the ${MAX_SESSION_OUTPUT_BYTES}-byte ceiling; ` +
                `capture stopped, session continues`,
            );
          }
          return;
        }
        this.totalOutputBytes += Buffer.byteLength(text, "utf8");
      } else if (this.truncated) {
        return;
      }

      const line = encodeCastEvent((Date.now() - this.startedAtMs) / 1000, code, text);
      this.buffer.push(line);
      this.bufferedBytes += Buffer.byteLength(line, "utf8") + 1;
      this.totalEvents++;

      if (this.bufferedBytes >= CHUNK_FLUSH_BYTES) {
        this.scheduleFlush(true);
      } else if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.scheduleFlush(false), CHUNK_FLUSH_INTERVAL_MS);
        this.flushTimer.unref();
      }
    } catch (err) {
      this.fail("buffering an event", err);
    }
  }

  /** Queue a flush behind whatever is already writing. */
  private scheduleFlush(immediate: boolean): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.disabled) return;
    if (!immediate && this.buffer.length === 0) return;
    this.writeChain = this.writeChain.then(() => this.flushNow()).catch(() => {});
  }

  /** Write the buffered lines as the next chunk. Never rejects. */
  private async flushNow(): Promise<void> {
    if (this.disabled) return;
    const lines = this.buffer;
    if (lines.length === 0) return;
    this.buffer = [];
    const byteLength = this.bufferedBytes;
    this.bufferedBytes = 0;
    const seq = this.seq++;

    try {
      const body = `${lines.join("\n")}\n`;
      await db.insert(sshSessionRecordingChunks).values({
        id: randomUUID(),
        recordingId: this.recordingId,
        organizationId: this.organizationId,
        seq,
        payload: gzipSync(Buffer.from(body, "utf8")).toString("base64"),
        eventCount: lines.length,
        byteLength,
      });
    } catch (err) {
      // The chunk is gone either way; putting the lines back would write them
      // under a seq that has already been consumed, so stop instead.
      this.fail(`writing chunk ${seq}`, err);
    }
  }

  /** Stop recording after an error, without disturbing the session. */
  private fail(what: string, err: unknown): void {
    if (this.disabled) return;
    this.disabled = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    console.error(`[ssh-recording] ${this.recordingId}: ${what} failed; capture stopped:`, err);
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Drain whatever is in flight, then the tail.
    this.writeChain = this.writeChain.then(() => this.flushNow()).catch(() => {});
    try {
      await this.writeChain;
    } catch {
      /* flushNow never rejects; this is belt and braces */
    }

    const endedAt = new Date();
    try {
      await db
        .update(sshSessionRecordings)
        .set({
          status: this.truncated ? "truncated" : "complete",
          endedAt,
          durationMs: Math.max(0, endedAt.getTime() - this.startedAtMs),
          outputBytes: this.totalOutputBytes,
          eventCount: this.totalEvents,
          chunkCount: this.seq,
          hasInput: this.sawInput,
        })
        .where(
          and(
            eq(sshSessionRecordings.id, this.recordingId),
            eq(sshSessionRecordings.organizationId, this.organizationId),
          ),
        );
    } catch (err) {
      // The row stays `"recording"`; the list route settles stale rows on read,
      // so this degrades to "shows as abandoned" rather than "shows as live".
      console.error(`[ssh-recording] ${this.recordingId}: closing the row failed:`, err);
    }
  }
}
