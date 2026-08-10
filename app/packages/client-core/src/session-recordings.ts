/**
 * Recorded SSH sessions — the platform-neutral client half.
 *
 * Cloud-mode SSH is proxied server-side, so the server already holds every
 * byte of the pty and recording it is a tee rather than an agent on the
 * customer's host. What comes back here is an asciicast v2 document
 * (https://docs.asciinema.org/manual/asciicast/v2/), which is somebody else's
 * format on purpose: the same bytes play in our player, in `asciinema play`,
 * and in whatever the auditor already has.
 *
 * Server contract: `/api/org/:orgId/session-recordings` (web
 * `api/routes/session-recordings.ts`). Listing and playback take
 * `session-recordings:read`; policy changes and deletion take
 * `session-recordings:write`. Neither is in the `member` system role.
 *
 * The parsing and playback-clock helpers below are deliberately here rather
 * than in `@infrawrench/ui`: they are pure functions over a text document, and
 * putting them in client-core is what lets the mobile app list and scrub a
 * recording without loading a DOM component library.
 */
import type { CloudFetch } from "./fetch";

export type SessionRecordingStatus = "recording" | "complete" | "truncated" | "abandoned";

/** One recording's metadata, as `GET /session-recordings` returns it. */
export interface SessionRecording {
  id: string;
  /** Null when the session authenticated with an API key rather than a person. */
  userId: string | null;
  /** Name snapshot taken at record time, so a departed member still reads as one. */
  userName: string | null;
  accountId: string | null;
  resourceId: string | null;
  host: string;
  port: number;
  username: string;
  /** 1 for a direct session; higher when it jumped through bastions. */
  hopCount: number;
  cols: number;
  rows: number;
  /** True when the cast also contains keystrokes (org opted into input capture). */
  hasInput: boolean;
  status: SessionRecordingStatus;
  /** Terminal bytes captured, before compression. */
  outputBytes: number;
  eventCount: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}

export interface SessionRecordingUsage {
  recordingCount: number;
  /** Compressed size actually stored. */
  storedBytes: number;
  capturedBytes: number;
  oldestStartedAt: string | null;
}

export interface SessionRecordingSettings {
  enabled: boolean;
  captureInput: boolean;
  retentionDays: number;
  usage: SessionRecordingUsage;
}

export interface SessionRecordingFilters {
  status?: SessionRecordingStatus;
  userId?: string;
  resourceId?: string;
  accountId?: string;
  /** ISO instants. */
  since?: string;
  until?: string;
  limit?: number;
}

function toQuery(filters: SessionRecordingFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function fetchSessionRecordings(
  api: CloudFetch,
  orgId: string,
  filters: SessionRecordingFilters = {},
): Promise<SessionRecording[]> {
  return (await api.org<SessionRecording[]>(orgId, `/session-recordings${toQuery(filters)}`)) ?? [];
}

export async function fetchSessionRecordingSettings(
  api: CloudFetch,
  orgId: string,
): Promise<SessionRecordingSettings | null> {
  return api.org<SessionRecordingSettings>(orgId, "/session-recordings/settings");
}

export async function updateSessionRecordingSettings(
  api: CloudFetch,
  orgId: string,
  patch: Partial<Pick<SessionRecordingSettings, "enabled" | "captureInput" | "retentionDays">>,
): Promise<SessionRecordingSettings | null> {
  return api.org<SessionRecordingSettings>(orgId, "/session-recordings/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function deleteSessionRecording(
  api: CloudFetch,
  orgId: string,
  recordingId: string,
): Promise<void> {
  await api.org(orgId, `/session-recordings/${encodeURIComponent(recordingId)}`, {
    method: "DELETE",
  });
}

/**
 * Fetch the raw `.cast`. Uses `raw` rather than `org` because the body is a
 * text document, not JSON — the JSON helper would try to parse it and fail on
 * the very first line.
 */
export async function fetchSessionRecordingCast(
  api: CloudFetch,
  orgId: string,
  recordingId: string,
): Promise<string> {
  const url =
    `${api.baseUrl}/api/org/${encodeURIComponent(orgId)}` +
    `/session-recordings/${encodeURIComponent(recordingId)}/cast`;
  const res = await api.raw(url, { method: "GET" });
  if (!res.ok) throw new Error(`Could not load the recording (${res.status})`);
  return res.text();
}

/* ------------------------------------------------------------------ *
 * Cast parsing and playback timing — pure, so every surface shares it.
 * ------------------------------------------------------------------ */

export type CastEventCode = "o" | "i" | "r";

export interface CastEvent {
  /** Seconds since the session started. */
  time: number;
  code: CastEventCode;
  data: string;
}

export interface ParsedCast {
  width: number;
  height: number;
  /** Session start, seconds since the epoch. */
  timestamp: number;
  title?: string;
  events: CastEvent[];
  /** Time of the last event; the player's total length. */
  durationSeconds: number;
}

/**
 * Parse a `.cast` document.
 *
 * Tolerant by design: a blank or unparseable line is skipped rather than
 * failing the document. Recordings are assembled from append-only chunks, so
 * the realistic damage is a truncated final line — and dropping one frame
 * beats refusing to play the ten minutes in front of it.
 */
export function parseCast(text: string): ParsedCast {
  const lines = text.split("\n");
  const headerIndex = lines.findIndex((l) => l.trim().length > 0);
  if (headerIndex === -1) throw new Error("This recording is empty.");

  let header: { width?: unknown; height?: unknown; timestamp?: unknown; title?: unknown };
  try {
    header = JSON.parse(lines[headerIndex]!) as typeof header;
  } catch {
    throw new Error("This recording is not a valid asciicast.");
  }

  const events: CastEvent[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!Array.isArray(parsed) || parsed.length < 3) continue;
      const [time, code, data] = parsed as [unknown, unknown, unknown];
      if (typeof time !== "number" || typeof data !== "string") continue;
      if (code !== "o" && code !== "i" && code !== "r") continue;
      events.push({ time, code, data });
    } catch {
      /* see the note above */
    }
  }

  return {
    width: typeof header.width === "number" ? header.width : 80,
    height: typeof header.height === "number" ? header.height : 24,
    timestamp: typeof header.timestamp === "number" ? header.timestamp : 0,
    ...(typeof header.title === "string" ? { title: header.title } : {}),
    events,
    durationSeconds: events.length > 0 ? events[events.length - 1]!.time : 0,
  };
}

/**
 * Everything that must be written to reach `toSeconds` from a cold terminal.
 *
 * Seeking a terminal is not seeking a video: the screen at t is the *product*
 * of every byte before t, so there is no keyframe to jump to. The only correct
 * answer is to replay from the start with the delays removed, which is what
 * this returns — the caller clears the terminal and writes the concatenation.
 *
 * Input events are excluded: they were never rendered by the host in the first
 * place (the echo you see is output), so replaying them would inject text the
 * session never showed.
 */
export function castOutputThrough(cast: ParsedCast, toSeconds: number): string {
  let out = "";
  for (const event of cast.events) {
    if (event.time > toSeconds) break;
    if (event.code === "o") out += event.data;
  }
  return out;
}

/** Index of the first event strictly after `seconds` — where playback resumes. */
export function castResumeIndex(cast: ParsedCast, seconds: number): number {
  let i = 0;
  while (i < cast.events.length && cast.events[i]!.time <= seconds) i++;
  return i;
}

/** Parse an `"r"` event's `"120x40"` payload. Null when it is malformed. */
export function parseResizeData(data: string): { cols: number; rows: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(data.trim());
  if (!match) return null;
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

/** "4m 12s" / "38s" / "1h 02m" — the duration column and the player's clock. */
export function formatRecordingDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** "0:38" / "12:04" / "1:02:11" — the scrubber's position readout. */
export function formatPlaybackClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(secs).padStart(2, "0")}`;
}

/** "1.2 MB" — sizes in the list and the storage summary. */
export function formatRecordingBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
