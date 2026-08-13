/**
 * asciicast v2 encoding — the on-disk (and on-the-wire) format for recorded
 * SSH sessions.
 *
 * Deliberately somebody else's format. A recording that only our player can
 * open is worth very little to the auditor it exists for, whereas a `.cast`
 * plays in `asciinema play`, in the reference web player, and in half a dozen
 * third-party viewers. The spec is
 * https://docs.asciinema.org/manual/asciicast/v2/ — a JSON header object on
 * line one, then one JSON array per line:
 *
 *     {"version": 2, "width": 120, "height": 30, "timestamp": 1754524800}
 *     [0.248, "o", "$ "]
 *     [1.001, "i", "ls\r"]
 *     [1.740, "r", "120x40"]
 *
 * Pure functions only: no database, no clock, no I/O. The recorder decides
 * *when* an event happened; this module only decides how it is written down.
 */
import type { CastEvent, CastEventCode } from "@infrawrench/client-core";

/**
 * Event kinds we emit. `"o"` output, `"i"` input, `"r"` resize, `"m"` marker.
 *
 * Markers are asciinema's own annotation event — a labelled point on the
 * timeline that its player renders as a chapter and that `asciinema play`
 * ignores harmlessly. We emit one whenever the cast needs to say something the
 * byte stream does not: somebody joined the shared session, somebody took the
 * keyboard, the share was revoked. Putting that in-band means the tape answers
 * "whose hands were on this at 04:12" on its own, in a format a third-party
 * viewer already understands, rather than only in a column beside it.
 *
 * The vocabulary is the wire contract; client-core (`session-recordings.ts`)
 * owns it, and the parsers on both sides accept exactly this set.
 */
export type { CastEventCode };

export interface CastHeader {
  width: number;
  height: number;
  /** Session start, whole seconds since the epoch (the spec's field). */
  timestamp: number;
  title?: string;
  /** Rendered as the asciicast `env` map; we set `TERM` and `SHELL`-ish hints. */
  env?: Record<string, string>;
}

/**
 * Serialize the header line (no trailing newline).
 *
 * Field order follows the spec's own examples rather than insertion order, so
 * two casts of the same session are byte-identical and a diff of two downloads
 * is about their content.
 */
export function encodeCastHeader(header: CastHeader): string {
  const out: Record<string, unknown> = {
    version: 2,
    width: Math.max(1, Math.trunc(header.width)),
    height: Math.max(1, Math.trunc(header.height)),
    timestamp: Math.trunc(header.timestamp),
  };
  if (header.title) out["title"] = header.title;
  if (header.env && Object.keys(header.env).length > 0) out["env"] = header.env;
  return JSON.stringify(out);
}

/**
 * Serialize one event line (no trailing newline).
 *
 * `elapsedSeconds` is seconds since the header's `timestamp`, rounded to
 * milliseconds. Rounding rather than keeping the float is what stops a
 * long session's lines from growing a 17-digit tail apiece — at 1ms the
 * quantisation is far below what a terminal reader can perceive, and it makes
 * the size accounting in the recorder predictable.
 */
export function encodeCastEvent(elapsedSeconds: number, code: CastEventCode, data: string): string {
  const t = Math.max(0, Math.round(elapsedSeconds * 1000) / 1000);
  return JSON.stringify([t, code, data]);
}

/** `[cols, rows]` rendered the way an `"r"` event's data field wants it. */
export function encodeResizeData(cols: number, rows: number): string {
  return `${Math.max(1, Math.trunc(cols))}x${Math.max(1, Math.trunc(rows))}`;
}

/** One decoded event, as the player consumes it. Client-core owns the shape. */
export type { CastEvent };

export interface ParsedCast {
  header: CastHeader & { version: number };
  events: CastEvent[];
}

/**
 * Parse a `.cast` document.
 *
 * Tolerant on purpose: blank lines are skipped and a line that does not parse
 * is dropped rather than failing the whole recording. A cast is an append-only
 * artifact assembled from chunks, so the realistic corruption is a truncated
 * final line — and losing that last frame is enormously better than refusing
 * to play the ten minutes in front of it.
 *
 * Throws only when the header itself is unreadable, because without geometry
 * there is nothing to play the events into.
 */
export function parseCast(text: string): ParsedCast {
  const lines = text.split("\n");
  const headerLine = lines.find((l) => l.trim().length > 0);
  if (!headerLine) throw new Error("Recording is empty.");
  let header: ParsedCast["header"];
  try {
    const raw = JSON.parse(headerLine) as Record<string, unknown>;
    header = {
      version: typeof raw["version"] === "number" ? raw["version"] : 2,
      width: typeof raw["width"] === "number" ? raw["width"] : 80,
      height: typeof raw["height"] === "number" ? raw["height"] : 24,
      timestamp: typeof raw["timestamp"] === "number" ? raw["timestamp"] : 0,
      ...(typeof raw["title"] === "string" ? { title: raw["title"] } : {}),
    };
  } catch {
    throw new Error("Recording header is not valid asciicast v2.");
  }

  const events: CastEvent[] = [];
  for (const line of lines.slice(lines.indexOf(headerLine) + 1)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!Array.isArray(parsed) || parsed.length < 3) continue;
      const [time, code, data] = parsed as [unknown, unknown, unknown];
      if (typeof time !== "number" || typeof data !== "string") continue;
      if (code !== "o" && code !== "i" && code !== "r" && code !== "m") continue;
      events.push({ time, code, data });
    } catch {
      // Truncated or otherwise unreadable line — see the note above.
    }
  }
  return { header, events };
}
