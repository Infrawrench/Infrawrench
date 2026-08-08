/**
 * SSH session recording schema.
 *
 * Cloud-mode SSH already goes through the server (`services/ssh-proxy.ts`
 * bridges the browser's WebSocket to ssh2), so every byte of the pty is
 * already in our hands. Recording is therefore a tee on a stream we hold, not
 * an agent on the customer's host — which is the whole reason this is cheap
 * for us and expensive for everyone else.
 *
 * Casts are stored in the shape asciinema already defined
 * (https://docs.asciinema.org/manual/asciicast/v2/): a JSON header line then
 * one `[elapsedSeconds, code, data]` event per line. Nothing here invents a
 * format, so a recording downloads as a `.cast` a customer can play with
 * `asciinema play` (or hand to an auditor) without our player.
 *
 * Split across two tables because the write pattern and the read pattern
 * differ: the proxy appends fixed-size chunks while the session is live and
 * must never hold a whole session in memory, while the list view wants one
 * cheap row per session. `ssh_session_recordings` is that row;
 * `ssh_session_recording_chunks` is the tape.
 */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { organizations, users } from "./core-schema.js";

/**
 * Per-org recording policy. Absent row means "not recording" — recording is
 * opt-in, never a default, because a terminal capture is a wiretap on your own
 * staff and turning that on is a decision an organization makes deliberately.
 */
export const orgSessionRecordingSettings = pgTable("org_session_recording_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** Record cloud-proxied SSH sessions for this org at all. */
  enabled: boolean("enabled").notNull().default(false),
  /**
   * Also capture keystrokes the operator sent, as asciicast `"i"` events.
   *
   * Off by default and separate from `enabled` for a specific reason: output
   * capture answers "what happened on this host", which is the compliance
   * question, while input capture also records anything typed at a prompt the
   * remote host chose not to echo — a sudo password, a token pasted into an
   * editor. That is a materially different promise to make to the people being
   * recorded, so it is its own switch.
   */
  captureInput: boolean("capture_input").notNull().default(false),
  /**
   * Days a recording is kept before the retention pass deletes it. Bounded
   * (1..3650) by the settings route; the pass reads it per org.
   */
  retentionDays: integer("retention_days").notNull().default(90),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * One recorded SSH session — the index row, never the payload.
 *
 * `status` is `"recording"` for a live session. A session whose proxy process
 * dies mid-stream never gets its closing write, so a row that is still
 * `"recording"` well after `last_activity_at` is an abandoned one; the list
 * route settles those on read rather than leaving them to look live forever.
 * Activity is both chunk flushes and an idle heartbeat — a quiet shell still
 * open is not abandoned.
 *
 * `accountId` / `resourceId` are deliberately not foreign keys. A recording
 * outlives what it was taken against — the whole point of an audit artifact is
 * that deleting the box does not delete the evidence — and an FK with a
 * cascade would do exactly the wrong thing.
 */
export const sshSessionRecordings = pgTable(
  "ssh_session_recordings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Who opened the session. Null when the socket authenticated with an API key. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Display-name snapshot, so a removed member still reads as a person. */
    userName: text("user_name"),
    /** The account the session was opened through (see the FK note above). */
    accountId: text("account_id"),
    /** The resource row the terminal was opened from, when it came from one. */
    resourceId: text("resource_id"),
    /** Final hop, as dialled. */
    host: text("host").notNull(),
    port: integer("port").notNull().default(22),
    username: text("username").notNull(),
    /** 1 for a direct session; >1 when the session jumped through bastions. */
    hopCount: integer("hop_count").notNull().default(1),
    /** Terminal geometry at open, for the asciicast header. */
    cols: integer("cols").notNull().default(80),
    rows: integer("rows").notNull().default(24),
    /** True when this cast also contains `"i"` (input) events. */
    hasInput: boolean("has_input").notNull().default(false),
    /** "recording" | "complete" | "truncated" | "abandoned" */
    status: text("status").notNull().default("recording"),
    /** Terminal bytes captured. The size budget is enforced against this. */
    outputBytes: integer("output_bytes").notNull().default(0),
    eventCount: integer("event_count").notNull().default(0),
    chunkCount: integer("chunk_count").notNull().default(0),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    /**
     * Last time the live recorder touched this row (chunk flush or idle
     * heartbeat). Settle/list treat a stale value as abandoned; prune refuses
     * to delete anything whose activity is still inside the retention window.
     * Null only on pre-migration rows — readers fall back to started_at.
     */
    lastActivityAt: timestamp("last_activity_at").notNull().defaultNow(),
    endedAt: timestamp("ended_at"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    orgStartedIdx: index("ssh_session_recordings_org_started_idx").on(
      t.organizationId,
      t.startedAt,
    ),
    orgUserIdx: index("ssh_session_recordings_org_user_idx").on(t.organizationId, t.userId),
    orgStatusIdx: index("ssh_session_recordings_org_status_idx").on(t.organizationId, t.status),
    orgLastActivityIdx: index("ssh_session_recordings_org_last_activity_idx").on(
      t.organizationId,
      t.lastActivityAt,
    ),
  }),
);

/**
 * A slice of one recording's asciicast body: newline-delimited event JSON,
 * gzipped, base64 in a `text` column.
 *
 * Chunked rather than one growing column because the proxy appends while the
 * session is live: rewriting a single column per flush is O(session²) writes
 * and holds the whole cast in memory to do it. Appending immutable chunks is
 * O(session), and playback is `ORDER BY seq` — which is also exactly the order
 * a download streams them in.
 *
 * gzip because terminal output is the single most compressible thing a server
 * handles (a TUI redraws the same frame over and over); base64 costs a third
 * back and buys not having to care whether the driver round-trips `bytea`.
 */
export const sshSessionRecordingChunks = pgTable(
  "ssh_session_recording_chunks",
  {
    id: text("id").primaryKey(),
    recordingId: text("recording_id")
      .notNull()
      .references(() => sshSessionRecordings.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** 0-based position in the tape. */
    seq: integer("seq").notNull(),
    /** base64(gzip(newline-delimited asciicast events)). */
    payload: text("payload").notNull(),
    eventCount: integer("event_count").notNull().default(0),
    /** Uncompressed length of this chunk's event lines, for size accounting. */
    byteLength: integer("byte_length").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    recordingSeqUnique: uniqueIndex("ssh_session_recording_chunks_recording_seq_unique").on(
      t.recordingId,
      t.seq,
    ),
    orgIdx: index("ssh_session_recording_chunks_org_idx").on(t.organizationId),
  }),
);
