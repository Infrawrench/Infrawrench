/**
 * Heartbeat monitors: a scheduled job pings a secret URL each time it runs,
 * and a heartbeat whose ping is late past its grace period goes down and
 * alerts. Synthetic probes check outward; a heartbeat catches the job that
 * silently stopped running.
 *
 * This module is the shared pure half every surface uses: the wire contract
 * for `/api/org/:orgId/heartbeats`, the limits the editor UIs and the server
 * both clamp against (the `PROBE_LIMITS` stance), the schedule arithmetic the
 * server's deadline and the editor's "next expected" preview both come from,
 * the provider-schedule normaliser that turns a plugin's flagged cron field
 * into something the heartbeat can watch, and the Bearer fetch helpers mobile
 * and the CLI call.
 *
 * Cron arithmetic is `./cron.ts` (the workflow engine: IANA time zones, DST
 * handled the way cron daemons handle it), not `./ci-cron.ts`, which is UTC
 * only by design.
 */
import type { CloudFetch } from "./fetch";
import { nextCronOccurrence, validateCronExpression, isValidCronTimezone } from "./cron";

/**
 * `new` until the first ping arrives (a heartbeat never alerts before its job
 * has reported once: it is usually created before the ping is added to the
 * job), `up` after a success, `down` after a missed deadline or a `/fail`.
 */
export type HeartbeatStatus = "new" | "up" | "down";

/** Why a heartbeat is down: its ping was late, or the job reported a failure. */
export type HeartbeatDownReason = "missed" | "failed";

export type HeartbeatScheduleKind = "cron" | "interval";

/** The three signals a job can send: `/<token>`, `/<token>/start`, `/<token>/fail`. */
export const HEARTBEAT_PING_KINDS = ["success", "start", "fail"] as const;
export type HeartbeatPingKind = (typeof HEARTBEAT_PING_KINDS)[number];

/** Bounds every heartbeat input is clamped into, shared by editors, API and pass. */
export const HEARTBEAT_LIMITS = {
  minIntervalMinutes: 1,
  /** 31 days: a monthly job on a fixed interval. Slower jobs use cron. */
  maxIntervalMinutes: 31 * 24 * 60,
  minGraceMinutes: 1,
  /** A week. Past that a late job is not late, it is gone. */
  maxGraceMinutes: 7 * 24 * 60,
  /** Hard cap per org: a governance rail, not a product tier. */
  maxPerOrg: 200,
  maxNameLength: 120,
  /**
   * Pings recorded per heartbeat per minute. Past it the ping URL answers 429
   * and nothing is written: a job in a hot loop must not fill the database.
   */
  maxPingsPerMinute: 20,
  /** Characters of a ping's request body kept with the ping (a failure's message). */
  maxPingBodyChars: 1000,
  /** How long ping history is kept. */
  pingRetentionDays: 30,
} as const;

export const HEARTBEAT_DEFAULTS = {
  scheduleKind: "interval" as HeartbeatScheduleKind,
  intervalMinutes: 60,
  graceMinutes: 10,
  timezone: "UTC",
} as const;

/** What the heartbeat expects: a cron expression in a zone, or a fixed interval. */
export type HeartbeatSchedule =
  | { kind: "cron"; cronExpression: string; timezone: string }
  | { kind: "interval"; intervalMinutes: number };

/** Wire shape of a heartbeat as every read endpoint returns it. */
export interface Heartbeat {
  id: string;
  name: string;
  scheduleKind: HeartbeatScheduleKind;
  /** Set when `scheduleKind` is `cron`; five fields, read in `timezone`. */
  cronExpression: string | null;
  timezone: string;
  /** Set when `scheduleKind` is `interval`. */
  intervalMinutes: number | null;
  graceMinutes: number;
  enabled: boolean;
  status: HeartbeatStatus;
  downReason: HeartbeatDownReason | null;
  /**
   * The secret URL the job pings. Absolute when the server knows its public
   * address, otherwise a path (`/api/ping/<token>`) to resolve against it.
   */
  pingUrl: string;
  lastPingAt: string | null;
  lastStartAt: string | null;
  lastFailAt: string | null;
  /** The last completed run's duration, from a `/start` to the ping that closed it. */
  lastDurationMs: number | null;
  /** When the next ping is due; null while new, paused or down. */
  nextExpectedAt: string | null;
  /** `nextExpectedAt` plus the grace period: past this the heartbeat goes down. */
  deadlineAt: string | null;
  lastStateChangeAt: string | null;
  /** Linked resource identity, which scheduled resource the heartbeat watches. */
  accountId: string | null;
  resourceId: string | null;
  pluginId: string | null;
  resourceTypeId: string | null;
  /** The resource field the schedule was read from. */
  fieldKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HeartbeatListResponse {
  heartbeats: Heartbeat[];
}

/** One recorded ping. */
export interface HeartbeatPing {
  id: string;
  kind: HeartbeatPingKind;
  receivedAt: string;
  /** For a success or fail that closed a run started with `/start`. */
  durationMs: number | null;
  method: string;
  userAgent: string | null;
  /** The start of the request body, when the job sent one (a failure's output). */
  body: string | null;
}

export interface HeartbeatPingsResponse {
  pings: HeartbeatPing[];
}

/** Body of `POST /api/org/:orgId/heartbeats`. */
export interface HeartbeatCreate {
  name: string;
  scheduleKind: HeartbeatScheduleKind;
  cronExpression?: string;
  timezone?: string;
  intervalMinutes?: number;
  graceMinutes?: number;
  enabled?: boolean;
  /** Link to the scheduled resource the schedule was read from. */
  resourceId?: string;
  fieldKey?: string;
}

/** Body of `PUT /api/org/:orgId/heartbeats/:id`; omitted fields keep their value. */
export interface HeartbeatPatch {
  name?: string;
  scheduleKind?: HeartbeatScheduleKind;
  cronExpression?: string;
  timezone?: string;
  intervalMinutes?: number;
  graceMinutes?: number;
  enabled?: boolean;
}

/**
 * A scheduled resource a heartbeat can watch: a resource whose type flags a
 * field `schedule: "cron"`, with the schedule read from it.
 */
export interface HeartbeatSuggestion {
  resourceId: string;
  displayName: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  fieldKey: string;
  /** The value exactly as the provider reported it. */
  rawSchedule: string;
  /** The value read as a heartbeat schedule, or null when it could not be. */
  schedule: HeartbeatSchedule | null;
  /** Ids of heartbeats already watching this resource. */
  watchedBy: string[];
}

export interface HeartbeatSuggestionsResponse {
  suggestions: HeartbeatSuggestion[];
}

// ---------------------------------------------------------------------------
// Limits and validation
// ---------------------------------------------------------------------------

/** Clamp a numeric input into a range, falling back when it is not a finite number. */
export function clampHeartbeatNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/**
 * Validate a schedule. Returns a human-readable problem or null; the editors
 * and the API refuse the same inputs with the same words.
 */
export function validateHeartbeatSchedule(schedule: HeartbeatSchedule): string | null {
  if (schedule.kind === "interval") {
    const n = schedule.intervalMinutes;
    if (!Number.isInteger(n)) return "The interval must be a whole number of minutes.";
    if (n < HEARTBEAT_LIMITS.minIntervalMinutes || n > HEARTBEAT_LIMITS.maxIntervalMinutes) {
      return `The interval must be between ${HEARTBEAT_LIMITS.minIntervalMinutes} and ${HEARTBEAT_LIMITS.maxIntervalMinutes} minutes.`;
    }
    return null;
  }
  if (!schedule.cronExpression.trim()) return "A cron expression is required.";
  const problem = validateCronExpression(schedule.cronExpression);
  if (problem !== null) return `The cron expression is not valid: ${problem}.`;
  if (!isValidCronTimezone(schedule.timezone)) return `Unknown time zone "${schedule.timezone}".`;
  if (nextCronOccurrence(schedule.cronExpression, { timezone: schedule.timezone }) === null) {
    return "The cron expression never fires.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Schedule arithmetic
// ---------------------------------------------------------------------------

/**
 * Pings a little early are still this run's: the next cron occurrence is
 * searched from this long after a ping, so a job at 02:00 whose clock runs a
 * few seconds fast and pings at 01:59:50 is not then expected again at 02:00.
 */
const EARLY_PING_SLACK_MS = 30_000;

/** When the job is next expected to ping, given it last pinged at `after`. */
export function heartbeatNextExpected(schedule: HeartbeatSchedule, after: Date): Date | null {
  if (schedule.kind === "interval") {
    return new Date(after.getTime() + schedule.intervalMinutes * 60_000);
  }
  try {
    return nextCronOccurrence(schedule.cronExpression, {
      from: new Date(after.getTime() + EARLY_PING_SLACK_MS),
      timezone: schedule.timezone,
    });
  } catch {
    return null;
  }
}

/** The moment past which a heartbeat that last pinged at `after` is down. */
export function heartbeatDeadline(
  schedule: HeartbeatSchedule,
  graceMinutes: number,
  after: Date,
): Date | null {
  const expected = heartbeatNextExpected(schedule, after);
  return expected === null ? null : new Date(expected.getTime() + graceMinutes * 60_000);
}

/** The schedule a wire heartbeat describes, or null when its row is inconsistent. */
export function heartbeatScheduleOf(
  heartbeat: Pick<Heartbeat, "scheduleKind" | "cronExpression" | "timezone" | "intervalMinutes">,
): HeartbeatSchedule | null {
  if (heartbeat.scheduleKind === "cron") {
    return heartbeat.cronExpression
      ? { kind: "cron", cronExpression: heartbeat.cronExpression, timezone: heartbeat.timezone }
      : null;
  }
  return heartbeat.intervalMinutes !== null
    ? { kind: "interval", intervalMinutes: heartbeat.intervalMinutes }
    : null;
}

/** A plain-English schedule for the CLI and mobile (the web UI renders its own). */
export function describeHeartbeatSchedule(schedule: HeartbeatSchedule): string {
  if (schedule.kind === "cron") {
    return schedule.timezone === "UTC"
      ? `cron ${schedule.cronExpression}`
      : `cron ${schedule.cronExpression} (${schedule.timezone})`;
  }
  const n = schedule.intervalMinutes;
  if (n % 1440 === 0) return n === 1440 ? "every day" : `every ${n / 1440} days`;
  if (n % 60 === 0) return n === 60 ? "every hour" : `every ${n / 60} hours`;
  return n === 1 ? "every minute" : `every ${n} minutes`;
}

/** The three URLs a job can call, from a heartbeat's `pingUrl`. */
export function heartbeatPingUrls(pingUrl: string): Record<HeartbeatPingKind, string> {
  const base = pingUrl.replace(/\/+$/, "");
  return { success: base, start: `${base}/start`, fail: `${base}/fail` };
}

/**
 * The shell snippet the UI offers to copy: start, run, then success or fail
 * with the job's exit status. `-m 10` bounds each call so a slow ping can
 * never hold a job up, and `--retry 3` rides out a blip.
 */
export function heartbeatCurlSnippet(pingUrl: string, command = "./your-job.sh"): string {
  const urls = heartbeatPingUrls(pingUrl);
  return [
    `curl -fsS -m 10 --retry 3 -o /dev/null ${urls.start}`,
    `if ${command}; then`,
    `  curl -fsS -m 10 --retry 3 -o /dev/null ${urls.success}`,
    "else",
    `  curl -fsS -m 10 --retry 3 -o /dev/null ${urls.fail}`,
    "fi",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Provider schedules
// ---------------------------------------------------------------------------

const SHORTCUTS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** A day-of-week field written with names (`MON-FRI`), which is not a time zone. */
const WEEKDAY_FIELD = /^(?:sun|mon|tue|wed|thu|fri|sat)(?:[-,](?:sun|mon|tue|wed|thu|fri|sat))*$/i;

const UNIT_MINUTES: Record<string, number> = {
  second: 1 / 60,
  seconds: 1 / 60,
  minute: 1,
  minutes: 1,
  min: 1,
  mins: 1,
  hour: 60,
  hours: 60,
  day: 1440,
  days: 1440,
  week: 10080,
  weeks: 10080,
};

function interval(minutes: number): HeartbeatSchedule | null {
  const whole = Math.max(HEARTBEAT_LIMITS.minIntervalMinutes, Math.round(minutes));
  if (!Number.isFinite(whole) || whole > HEARTBEAT_LIMITS.maxIntervalMinutes) return null;
  return { kind: "interval", intervalMinutes: whole };
}

/** `5m`, `1h30m`, `90s`: a Go-style duration, in minutes. */
function goDurationMinutes(text: string): number | null {
  const re = /(\d+(?:\.\d+)?)(h|m|s)/g;
  let total = 0;
  let consumed = 0;
  for (const match of text.matchAll(re)) {
    const n = Number(match[1]);
    total += match[2] === "h" ? n * 60 : match[2] === "m" ? n : n / 60;
    consumed += match[0].length;
  }
  return consumed === text.length && consumed > 0 ? total : null;
}

/**
 * Shift a numeric day-of-week field from the 1-7 = SUN-SAT numbering (AWS,
 * Quartz) to cron's 0-6. Names pass through. Null when the field uses the
 * `L`/`#` forms, which a five-field cron cannot express.
 */
function shiftWeekdays(field: string): string | null {
  if (/[L#W]/i.test(field)) return null;
  return field.replace(/\d+/g, (d, offset: number, whole: string) => {
    // A step's number is a count, not a weekday: leave `*/2` alone.
    if (whole[offset - 1] === "/") return d;
    const n = Number(d);
    return n >= 1 && n <= 7 ? String(n - 1) : d;
  });
}

function cron(expression: string, timezone: string): HeartbeatSchedule | null {
  const normalized = expression.trim().replace(/\?/g, "*").replace(/\s+/g, " ");
  if (/[LW#]/i.test(normalized.replace(/[a-z]{3}/gi, ""))) return null;
  if (validateCronExpression(normalized) !== null) return null;
  if (!isValidCronTimezone(timezone)) return null;
  return { kind: "cron", cronExpression: normalized, timezone };
}

/**
 * Read a provider's schedule value as a heartbeat schedule.
 *
 * Plugins flag the field that holds a job's schedule (`schedule: "cron"`) and,
 * when the provider keeps one, the field holding its time zone
 * (`schedule: "timezone"`). Providers write schedules in several dialects,
 * and this is the one place that knows them, so no plugin and no host has to:
 *
 * - five-field cron, and the `@hourly` family;
 * - a `CRON_TZ=`/`TZ=` prefix, a trailing IANA zone (`0 * * * * Europe/Paris`)
 *   or a trailing whole-hour offset (`0 9 * * * +09:00`);
 * - Quartz: six or seven fields with seconds first and an optional year, `?`
 *   for "no specific value" and 1-7 = SUN-SAT;
 * - AWS `cron(m h dom mon dow year)` and `rate(5 minutes)`;
 * - `USING CRON <expr> <zone>` and `5 MINUTE` (warehouse task schedules);
 * - `every 5 minutes`, `10 minute`, `every 1 day`, Go and Flux durations
 *   (`@every 1h30m`, `15m`), and `cron <expr> (<zone>)`.
 *
 * Returns null for anything else (systemd calendar events, `L`/`#` day forms,
 * several schedules in one value, a zone that is not an IANA name): the
 * caller shows the raw value for the user to rewrite.
 */
export function normalizeProviderSchedule(
  raw: unknown,
  timezoneRaw?: unknown,
): HeartbeatSchedule | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text) return null;
  // Several schedules joined into one value ("0 * * * *, */5 * * * *"): no
  // single heartbeat describes that. Cron's own lists have no space after
  // the comma.
  if (/,\s/.test(text)) return null;

  let timezone = "UTC";
  if (typeof timezoneRaw === "string" && timezoneRaw.trim()) {
    const zone = timezoneRaw.trim();
    // A zone name that is not IANA (a Rails-style "Pacific Time (US &
    // Canada)") must not quietly become UTC: the deadlines would be hours off.
    if (zone.toLowerCase() === "utc") timezone = "UTC";
    else if (isValidCronTimezone(zone)) timezone = zone;
    else return null;
  }

  // AWS: rate(5 minutes), cron(0 12 * * ? *).
  const rate = /^rate\(\s*(\d+)\s+([a-z]+)\s*\)$/i.exec(text);
  if (rate) {
    const unit = UNIT_MINUTES[rate[2]!.toLowerCase()];
    return unit === undefined ? null : interval(Number(rate[1]) * unit);
  }
  const awsCron = /^cron\((.*)\)$/i.exec(text);
  if (awsCron) {
    const fields = awsCron[1]!.trim().split(/\s+/);
    if (fields.length !== 6 || fields[5] !== "*") return null;
    const dow = shiftWeekdays(fields[4]!);
    if (dow === null) return null;
    return cron([...fields.slice(0, 4), dow].join(" "), timezone);
  }

  // "cron 0 9 * * * (Europe/Paris)": a schedule already rendered as text.
  const rendered = /^cron\s+(.+?)\s*\(([^)]+)\)$/i.exec(text);
  if (rendered) {
    if (!isValidCronTimezone(rendered[2]!.trim())) return null;
    timezone = rendered[2]!.trim();
    text = rendered[1]!.trim();
  }

  // "5 MINUTE", "every 5 minutes", "every 1 day".
  const plain = /^(?:every\s+)?(\d+)\s*([a-z]+)$/i.exec(text);
  if (plain && UNIT_MINUTES[plain[2]!.toLowerCase()] !== undefined) {
    return interval(Number(plain[1]) * UNIT_MINUTES[plain[2]!.toLowerCase()]!);
  }
  // "@every 1h30m", "every 1h 30m", "15m".
  const duration = /^(?:@?every\s+)?((?:\d+(?:\.\d+)?[hms]\s*)+)$/i.exec(text);
  if (duration) {
    const minutes = goDurationMinutes(duration[1]!.replace(/\s+/g, "").toLowerCase());
    return minutes === null ? null : interval(minutes);
  }

  // "USING CRON 0 9 * * * America/Los_Angeles".
  const using = /^using\s+cron\s+(.*)$/i.exec(text);
  if (using) text = using[1]!.trim();

  // CRON_TZ=Europe/Paris 0 2 * * *
  const prefixed = /^(?:CRON_TZ|TZ)=(\S+)\s+(.*)$/.exec(text);
  if (prefixed) {
    if (!isValidCronTimezone(prefixed[1]!)) return null;
    timezone = prefixed[1]!;
    text = prefixed[2]!.trim();
  }

  let fields = text.split(/\s+/);
  // A trailing time zone: "0 * * * * America/New_York", "@daily UTC", or a
  // whole-hour offset "0 9 * * * +09:00".
  if (fields.length === 2 || fields.length >= 6) {
    const last = fields[fields.length - 1]!;
    const offset = /^([+-])(\d{1,2})(?::?00)?$/.exec(last);
    if (offset) {
      const hours = Number(offset[2]);
      if (hours > 14) return null;
      // The Etc zones' signs are inverted: UTC+9 is Etc/GMT-9.
      timezone = hours === 0 ? "UTC" : `Etc/GMT${offset[1] === "+" ? "-" : "+"}${hours}`;
      fields = fields.slice(0, -1);
    } else if (/^[+-]\d/.test(last)) {
      return null;
    } else if (/[A-Za-z]/.test(last) && !WEEKDAY_FIELD.test(last) && isValidCronTimezone(last)) {
      timezone = last;
      fields = fields.slice(0, -1);
    }
  }

  if (fields.length === 1) {
    const shortcut = SHORTCUTS[fields[0]!.toLowerCase()];
    return shortcut ? cron(shortcut, timezone) : null;
  }
  if (fields.length === 5) return cron(fields.join(" "), timezone);
  if (fields.length === 6 || fields.length === 7) {
    // Quartz: seconds first, then an optional year that must be open.
    if (fields.length === 7 && fields[6] !== "*") return null;
    const [, minute, hour, dom, month, dowRaw] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const dow = shiftWeekdays(dowRaw);
    if (dow === null) return null;
    return cron([minute, hour, dom, month, dow].join(" "), timezone);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bearer fetch helpers (mobile, CLI)
// ---------------------------------------------------------------------------

/** Read `GET /api/org/:orgId/heartbeats` (`resources:read`). */
export async function fetchHeartbeats(
  api: CloudFetch,
  orgId: string,
): Promise<HeartbeatListResponse> {
  const res = await api.org<HeartbeatListResponse>(orgId, "/heartbeats");
  return res ?? { heartbeats: [] };
}

/** One heartbeat's recent pings, newest first (`resources:read`). */
export async function fetchHeartbeatPings(
  api: CloudFetch,
  orgId: string,
  heartbeatId: string,
): Promise<HeartbeatPingsResponse> {
  const res = await api.org<HeartbeatPingsResponse>(
    orgId,
    `/heartbeats/${encodeURIComponent(heartbeatId)}/pings`,
  );
  return res ?? { pings: [] };
}
