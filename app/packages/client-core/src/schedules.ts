/**
 * Sleep/wake schedules — "off at 19:00, on at 08:00, Mon–Fri" windows for
 * non-prod resources whose plugin declares a lifecycle start/stop action pair.
 *
 * This module is the shared pure half every surface uses: the wall-clock →
 * UTC transition math (DST-safe, `Intl` only — no runtime deps), the weekly
 * off-hours fraction the savings quote is built from, and the wire contract +
 * Bearer fetch helpers for `/api/org/:orgId/schedules`. The server-side
 * executor (`server-core/src/schedules/`) imports the same
 * `computeNextTransition` the editors preview with, so "next transition" can
 * never disagree between the poller and the UI.
 *
 * Day-of-week values are ISO 8601: 1 = Monday … 7 = Sunday. Times are
 * 24-hour `"HH:MM"` wall-clock strings in the schedule's IANA `timezone`.
 */
import type { CloudFetch } from "./fetch";

/** The user-editable timing half of a schedule. */
export interface SleepScheduleTiming {
  /** ISO weekdays (1 = Mon … 7 = Sun) the resource is worked on. */
  daysOfWeek: number[];
  /** Wall-clock `"HH:MM"` at which the resource is stopped on each selected day. */
  stopTime: string;
  /** Wall-clock `"HH:MM"` at which the resource is started on each selected day. */
  startTime: string;
  /** IANA zone the wall-clock times are interpreted in, e.g. `"Europe/London"`. */
  timezone: string;
}

export type ScheduleAction = "stop" | "start";

/** One future stop/start instant, computed in the schedule's zone. */
export interface ScheduleTransition {
  /** UTC instant, ISO 8601. */
  at: string;
  action: ScheduleAction;
}

export type ScheduleRunStatus = "ok" | "failed" | "skipped_freeze";

/** Wire shape of a schedule row as every read endpoint returns it. */
export interface SleepSchedule extends SleepScheduleTiming {
  id: string;
  resourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  /** Resource display name at read time; falls back to the resource id. */
  resourceName: string;
  accountName: string;
  paused: boolean;
  /** Next due transition; null while paused. */
  nextTransitionAt: string | null;
  nextTransitionAction: ScheduleAction | null;
  lastRunAt: string | null;
  lastRunAction: ScheduleAction | null;
  lastRunStatus: ScheduleRunStatus | null;
  /** Failure detail for `lastRunStatus === "failed"`; never silent. */
  lastRunError: string | null;
  /** Server-computed projection from `cost_daily`; null without billing data. */
  projectedMonthlySaving: number | null;
  currency: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SleepScheduleListResponse {
  schedules: SleepSchedule[];
}

/** Body of `POST /api/org/:orgId/schedules`. */
export interface SleepScheduleCreate extends SleepScheduleTiming {
  resourceId: string;
  accountId: string;
}

/** Body of `PUT /api/org/:orgId/schedules/:id`; omitted fields keep their value. */
export interface SleepSchedulePatch {
  daysOfWeek?: number[];
  stopTime?: string;
  startTime?: string;
  timezone?: string;
  paused?: boolean;
}

/** Body of `POST /api/org/:orgId/schedules/preview`. */
export interface SchedulePreviewRequest extends SleepScheduleTiming {
  resourceId: string;
  accountId: string;
}

/** The projected-saving quote shown before saving a schedule. */
export interface SchedulePreview {
  /** Fraction of the week (0–1) the resource would be off. */
  offFraction: number;
  /** Trailing spend normalized to a month; null when billing holds no rows. */
  monthlyCost: number | null;
  /** `monthlyCost × offFraction`; null when `monthlyCost` is. */
  projectedMonthlySaving: number | null;
  currency: string | null;
  /** Days of `cost_daily` the estimate was computed over (0 = none found). */
  costWindowDays: number;
  /** The next few transitions, soonest first. */
  nextTransitions: ScheduleTransition[];
}

export const SCHEDULE_LIMITS = {
  /** Hard cap on schedules per org — a governance rail, not a product tier. */
  maxPerOrg: 200,
} as const;

/** Strict 24-hour `"HH:MM"`. */
export const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Mean Gregorian month length; the normalization used by the savings quote. */
export const AVERAGE_DAYS_PER_MONTH = 30.437;

const MINUTES_PER_WEEK = 7 * 24 * 60;

/** ISO-ordered short labels; index 0 is Monday (ISO weekday 1). */
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function isValidTimeOfDay(value: string): boolean {
  return TIME_OF_DAY_RE.test(value);
}

/** Whether the runtime's `Intl` recognises the IANA zone. */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the timing half of a schedule. Returns a human-readable problem or
 * null when valid — shared verbatim by the editor UIs and the API boundary so
 * both reject the same inputs with the same words.
 */
export function validateScheduleTiming(timing: SleepScheduleTiming): string | null {
  if (!Array.isArray(timing.daysOfWeek) || timing.daysOfWeek.length === 0)
    return "Pick at least one day of the week.";
  const seen = new Set<number>();
  for (const day of timing.daysOfWeek) {
    if (!Number.isInteger(day) || day < 1 || day > 7)
      return "Days of week must be ISO weekdays 1 (Mon) through 7 (Sun).";
    if (seen.has(day)) return "Each day of the week can appear only once.";
    seen.add(day);
  }
  if (!isValidTimeOfDay(timing.stopTime)) return 'Off time must be 24-hour "HH:MM".';
  if (!isValidTimeOfDay(timing.startTime)) return 'On time must be 24-hour "HH:MM".';
  if (timing.stopTime === timing.startTime) return "Off and on times must differ.";
  if (!isValidTimeZone(timing.timezone)) return "Unknown timezone.";
  return null;
}

/** `"19:05"` → minutes since midnight. Callers validate first. */
export function timeOfDayMinutes(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Render a day set for humans: `[1..5]` → `"Mon–Fri"`, all seven →
 * `"Every day"`, non-contiguous → `"Mon, Wed, Fri"`.
 */
export function formatDaysOfWeek(daysOfWeek: readonly number[]): string {
  const days = [...new Set(daysOfWeek)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  days.sort((a, b) => a - b);
  if (days.length === 0) return "No days";
  if (days.length === 7) return "Every day";
  const contiguous = days.length >= 2 && days[days.length - 1]! - days[0]! === days.length - 1;
  if (contiguous)
    return `${WEEKDAY_LABELS[days[0]! - 1]}–${WEEKDAY_LABELS[days[days.length - 1]! - 1]}`;
  return days.map((d) => WEEKDAY_LABELS[d - 1]).join(", ");
}

// ---------------------------------------------------------------------------
// Wall-clock ↔ UTC (Intl-based; no runtime dependencies)
// ---------------------------------------------------------------------------

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function wallPartsAt(utcMs: number, timeZone: string): WallParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const out: WallParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of parts) {
    switch (part.type) {
      case "year":
        out.year = Number(part.value);
        break;
      case "month":
        out.month = Number(part.value);
        break;
      case "day":
        out.day = Number(part.value);
        break;
      case "hour":
        out.hour = Number(part.value);
        break;
      case "minute":
        out.minute = Number(part.value);
        break;
      case "second":
        out.second = Number(part.value);
        break;
    }
  }
  return out;
}

function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const p = wallPartsAt(utcMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

/**
 * The UTC instant at which a wall-clock time occurs in a zone, DST-safe.
 *
 * The classic two-pass `Intl` trick: guess the instant as if the wall time
 * were UTC, measure the zone's offset at the guess, re-measure at the
 * corrected instant (the offset may differ across a DST boundary), and apply
 * the second measurement. Times skipped by spring-forward resolve to the
 * instant one offset-change later (the transition still fires, once); times
 * repeated by fall-back resolve deterministically to one of the two.
 */
export function wallTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = zoneOffsetMs(timeZone, guess);
  const second = zoneOffsetMs(timeZone, guess - first);
  return guess - second;
}

export interface TransitionOptions {
  /** Reference instant, epoch ms; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
  /** How many transitions to return (default 4). */
  count?: number;
}

/**
 * The schedule's upcoming transitions, soonest first.
 *
 * Enumerates calendar dates in the schedule's zone (never fixed 24-hour steps
 * — DST days are 23 or 25 hours long) and emits a stop at `stopTime` and a
 * start at `startTime` on each selected day. Weekends fall out naturally: the
 * last selected day's stop is followed by the next selected day's start.
 * Returns `[]` when the timing is invalid rather than guessing.
 */
export function computeUpcomingTransitions(
  timing: SleepScheduleTiming,
  options: TransitionOptions = {},
): ScheduleTransition[] {
  if (validateScheduleTiming(timing) !== null) return [];
  const now = options.now ?? Date.now();
  const count = options.count ?? 4;
  if (count <= 0) return [];

  const selected = new Set(timing.daysOfWeek);
  const stop = timing.stopTime.split(":").map(Number) as [number, number];
  const start = timing.startTime.split(":").map(Number) as [number, number];

  // Today's calendar date in the schedule's zone, then walk forward day by
  // calendar day. Weekday comes from the date itself (getUTCDay over a UTC
  // noon anchor), so it is the zone's weekday for that date.
  const today = wallPartsAt(now, timing.timezone);
  const transitions: ScheduleTransition[] = [];
  // 9 days always covers `count` ≤ 4 even for a one-day-a-week schedule;
  // widen with `count` for callers that ask for a longer horizon.
  const horizonDays = Math.max(9, Math.ceil(count / 2) * 7 + 2);
  for (let i = 0; i <= horizonDays; i++) {
    const anchor = new Date(Date.UTC(today.year, today.month - 1, today.day + i, 12));
    const isoWeekday = ((anchor.getUTCDay() + 6) % 7) + 1;
    if (!selected.has(isoWeekday)) continue;
    const year = anchor.getUTCFullYear();
    const month = anchor.getUTCMonth() + 1;
    const day = anchor.getUTCDate();
    const candidates: Array<[number, ScheduleAction]> = [
      [wallTimeToUtc(timing.timezone, year, month, day, start[0], start[1]), "start"],
      [wallTimeToUtc(timing.timezone, year, month, day, stop[0], stop[1]), "stop"],
    ];
    for (const [at, action] of candidates) {
      if (at > now) transitions.push({ at: new Date(at).toISOString(), action });
    }
  }
  transitions.sort((a, b) => a.at.localeCompare(b.at) || a.action.localeCompare(b.action));
  return transitions.slice(0, count);
}

/**
 * The most recent transition at or before `now`, or null when the timing is
 * invalid or no transition has occurred within the trailing ~9 days.
 *
 * This is what the executor runs and what its idempotency key is built from:
 * a due schedule's "due transition" is recomputed from the timing rather than
 * carried through the claim, so a poller that was down for a while executes
 * only the latest missed transition — the one that decides the resource's
 * current desired state — instead of replaying history.
 */
export function computeMostRecentTransition(
  timing: SleepScheduleTiming,
  now?: number,
): ScheduleTransition | null {
  if (validateScheduleTiming(timing) !== null) return null;
  const at = now ?? Date.now();

  const selected = new Set(timing.daysOfWeek);
  const stop = timing.stopTime.split(":").map(Number) as [number, number];
  const start = timing.startTime.split(":").map(Number) as [number, number];
  const today = wallPartsAt(at, timing.timezone);

  let latest: ScheduleTransition | null = null;
  let latestMs = -Infinity;
  for (let i = 0; i >= -9; i--) {
    const anchor = new Date(Date.UTC(today.year, today.month - 1, today.day + i, 12));
    const isoWeekday = ((anchor.getUTCDay() + 6) % 7) + 1;
    if (!selected.has(isoWeekday)) continue;
    const year = anchor.getUTCFullYear();
    const month = anchor.getUTCMonth() + 1;
    const day = anchor.getUTCDate();
    const candidates: Array<[number, ScheduleAction]> = [
      [wallTimeToUtc(timing.timezone, year, month, day, start[0], start[1]), "start"],
      [wallTimeToUtc(timing.timezone, year, month, day, stop[0], stop[1]), "stop"],
    ];
    for (const [ms, action] of candidates) {
      if (ms <= at && ms > latestMs) {
        latestMs = ms;
        latest = { at: new Date(ms).toISOString(), action };
      }
    }
    // Any selected day fully in the past yields both its transitions; once we
    // hold one from a full day earlier than `i = 0`, nothing older can win.
    if (latest && i < 0) break;
  }
  return latest;
}

/** Deterministic idempotency key for one transition of one schedule. */
export function transitionKey(transition: ScheduleTransition): string {
  return `${transition.at}:${transition.action}`;
}

/** The next due transition, or null for an invalid timing. */
export function computeNextTransition(
  timing: SleepScheduleTiming,
  now?: number,
): ScheduleTransition | null {
  const next = computeUpcomingTransitions(timing, {
    ...(now !== undefined ? { now } : {}),
    count: 1,
  });
  return next[0] ?? null;
}

/**
 * Fraction of a week (0–1) the schedule keeps the resource stopped.
 *
 * Pure state-machine integration over one cyclic week: each selected day
 * contributes a stop event at `stopTime` and a start event at `startTime`;
 * the state entering the week is the state the last event of the week left
 * behind. Handles overnight on-windows (`startTime > stopTime`) and
 * unselected days (whatever state the previous selected day ended in
 * persists) without special cases. DST makes two real weeks a year 167 or
 * 169 hours long; the fraction is a steady-state estimate and ignores that.
 */
export function weeklyOffFraction(timing: SleepScheduleTiming): number {
  if (validateScheduleTiming(timing) !== null) return 0;
  const stopMinutes = timeOfDayMinutes(timing.stopTime);
  const startMinutes = timeOfDayMinutes(timing.startTime);

  const events: Array<{ weekMinute: number; action: ScheduleAction }> = [];
  for (const day of timing.daysOfWeek) {
    const base = (day - 1) * 24 * 60;
    events.push({ weekMinute: base + stopMinutes, action: "stop" });
    events.push({ weekMinute: base + startMinutes, action: "start" });
  }
  events.sort((a, b) => a.weekMinute - b.weekMinute);

  let state: ScheduleAction = events[events.length - 1]!.action;
  let cursor = 0;
  let offMinutes = 0;
  for (const event of events) {
    if (state === "stop") offMinutes += event.weekMinute - cursor;
    cursor = event.weekMinute;
    state = event.action;
  }
  if (state === "stop") offMinutes += MINUTES_PER_WEEK - cursor;
  return offMinutes / MINUTES_PER_WEEK;
}

/**
 * Normalize a trailing `cost_daily` window to a monthly figure and apply the
 * off-hours fraction. Null when the window held no data — a missing bill must
 * quote nothing, never `$0.00` (the orphan-finder rule).
 */
export function projectedMonthlySaving(
  windowTotal: number | null,
  windowDays: number,
  offFraction: number,
): number | null {
  if (windowTotal === null || windowDays <= 0) return null;
  return (windowTotal / windowDays) * AVERAGE_DAYS_PER_MONTH * offFraction;
}

/** `weeklyOffFraction` as hours per week — what the editor UIs print. */
export function hoursOffPerWeek(timing: SleepScheduleTiming): number {
  return weeklyOffFraction(timing) * 7 * 24;
}

// ---------------------------------------------------------------------------
// Bearer fetch helpers (mobile + any host that talks the cloud API directly)
// ---------------------------------------------------------------------------

/** Read `GET /api/org/:orgId/schedules` (permission `resources:read`). */
export async function fetchSchedules(
  api: CloudFetch,
  orgId: string,
): Promise<SleepScheduleListResponse> {
  const res = await api.org<SleepScheduleListResponse>(orgId, "/schedules");
  return res ?? { schedules: [] };
}

/** Create a schedule (`resources:write`). */
export async function createSchedule(
  api: CloudFetch,
  orgId: string,
  body: SleepScheduleCreate,
): Promise<SleepSchedule | null> {
  return api.org<SleepSchedule>(orgId, "/schedules", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Update a schedule — timing edits and the pause toggle (`resources:write`). */
export async function updateSchedule(
  api: CloudFetch,
  orgId: string,
  scheduleId: string,
  patch: SleepSchedulePatch,
): Promise<SleepSchedule | null> {
  return api.org<SleepSchedule>(orgId, `/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

/** Delete a schedule (`resources:write`). */
export async function deleteSchedule(
  api: CloudFetch,
  orgId: string,
  scheduleId: string,
): Promise<void> {
  await api.org(orgId, `/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" });
}

/** Quote the projected monthly saving before saving (`resources:read`). */
export async function previewSchedule(
  api: CloudFetch,
  orgId: string,
  body: SchedulePreviewRequest,
): Promise<SchedulePreview | null> {
  return api.org<SchedulePreview>(orgId, "/schedules/preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
