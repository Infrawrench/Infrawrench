/**
 * On-call rotations — who to wake, rather than which channel to shout into.
 *
 * Alert routing already answers "where does this go": a rule matches an alert
 * and names destinations. What it could not express is the thing every team
 * actually means — *whoever is on call*. A `on-call` destination resolves to a
 * person at the moment the alert fires, and its escalation walks the rotation
 * rather than a fixed list, so the handover on Monday morning does not require
 * anybody to edit a routing rule.
 *
 * Everything here is pure and clock-free (callers pass `now`), because the
 * settings editor previews the next fortnight of shifts with the same function
 * the alert path resolves with. A preview that could disagree with delivery
 * would be worse than no preview.
 *
 * **Shift arithmetic is calendar-day arithmetic, never 24-hour arithmetic.**
 * Two weeks contain a spring-forward or a fall-back twice a year, and a
 * rotation stepped in fixed milliseconds drifts an hour each time until the
 * "09:00 Monday" handover happens at 08:00 — or, worse, until the shift
 * boundary lands on the wrong side of the handover and two people each think
 * the other is on call.
 */
import { isValidTimeOfDay, isValidTimeZone, wallTimeToUtc } from "./schedules";

export interface OnCallSchedule {
  id: string;
  name: string;
  /** IANA zone the handover time is expressed in. */
  timezone: string;
  /**
   * Days per shift. 7 is the common case (weekly handover), 1 gives a daily
   * rotation, 14 a fortnightly one. Bounded rather than free-form: past a
   * month a "rotation" is a staffing decision, not a schedule.
   */
  rotationDays: number;
  /** Wall-clock "HH:MM" in `timezone` at which the shift changes hands. */
  handoffTime: string;
  /**
   * The calendar date (`YYYY-MM-DD`, in `timezone`) the first shift begins on,
   * at `handoffTime`. Every later boundary is derived from it, so moving this
   * moves the whole rotation — which is what an org that wants to re-anchor a
   * schedule actually means.
   */
  startDate: string;
  /**
   * Ordered participants. Position is the rotation order, so reordering the
   * list re-plans the future — deliberately, because that is what somebody
   * dragging a name is asking for.
   */
  participants: OnCallParticipant[];
  /**
   * Off means the schedule resolves to nobody. A destination pointing at a
   * disabled schedule falls through to the rule's other destinations rather
   * than failing the alert — see `resolveOnCall`.
   */
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OnCallParticipant {
  userId: string;
  /** Denormalized so a shift row renders without a second lookup. */
  name: string | null;
  email: string | null;
}

/**
 * A cover: one person taking another's place for a bounded window.
 *
 * Overrides beat the rotation for exactly their window and nothing else, and
 * they are stored rather than folded into the rotation because "Sam covered
 * Tuesday night" is a fact somebody will want to read back six months later.
 */
export interface OnCallOverride {
  id: string;
  scheduleId: string;
  userId: string;
  userName: string | null;
  /** ISO 8601. */
  startsAt: string;
  endsAt: string;
  reason: string | null;
  createdByUserId: string | null;
  createdAt: string;
}

export interface OnCallShift {
  /** ISO 8601, inclusive. */
  startsAt: string;
  /** ISO 8601, exclusive. */
  endsAt: string;
  userId: string;
  name: string | null;
  email: string | null;
  /** Whether this shift comes from the rotation or from a cover. */
  source: "rotation" | "override";
  /** Index into `participants` — null for an override, which has no position. */
  rotationIndex: number | null;
}

export const ON_CALL_LIMITS = {
  maxSchedulesPerOrg: 30,
  maxNameLength: 80,
  maxParticipants: 60,
  minRotationDays: 1,
  /** A month. Past that a "rotation" is a staffing decision, not a schedule. */
  maxRotationDays: 31,
  maxOverrideDays: 90,
  maxReasonLength: 200,
  /** How far the editor's preview and the API's `shifts` read may look. */
  maxPreviewShifts: 60,
} as const;

const MS_PER_DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface OnCallScheduleInput {
  name: string;
  timezone: string;
  rotationDays: number;
  handoffTime: string;
  startDate: string;
  participantUserIds: string[];
  enabled?: boolean;
}

/**
 * Validate a schedule as the editor and the API both see it. One sentence, or
 * null — the editor shows it above the save button.
 */
export function validateOnCallSchedule(input: OnCallScheduleInput): string | null {
  const name = input.name?.trim() ?? "";
  if (!name) return "A name is required.";
  if (name.length > ON_CALL_LIMITS.maxNameLength) {
    return `Name must be ${ON_CALL_LIMITS.maxNameLength} characters or fewer.`;
  }
  if (!isValidTimeZone(input.timezone)) return "Choose a valid time zone.";
  if (!isValidTimeOfDay(input.handoffTime)) return "The handover time must be HH:MM.";
  if (!DATE_RE.test(input.startDate) || Number.isNaN(Date.parse(`${input.startDate}T00:00:00Z`))) {
    return "The start date must be a calendar date (YYYY-MM-DD).";
  }
  if (
    !Number.isInteger(input.rotationDays) ||
    input.rotationDays < ON_CALL_LIMITS.minRotationDays ||
    input.rotationDays > ON_CALL_LIMITS.maxRotationDays
  ) {
    return `A shift must be between ${ON_CALL_LIMITS.minRotationDays} and ${ON_CALL_LIMITS.maxRotationDays} days.`;
  }
  if (input.participantUserIds.length === 0) {
    return "Add at least one person to the rotation.";
  }
  if (input.participantUserIds.length > ON_CALL_LIMITS.maxParticipants) {
    return `A rotation may have at most ${ON_CALL_LIMITS.maxParticipants} people.`;
  }
  if (new Set(input.participantUserIds).size !== input.participantUserIds.length) {
    // Not merely untidy: the same person twice in a six-person rotation is on
    // call a third of the time, which is almost never what the author meant and
    // is invisible in a list of names.
    return "Each person may appear in the rotation once.";
  }
  return null;
}

/** `YYYY-MM-DD` for an instant, in a named zone. */
function zonedDayKey(atMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(atMs));
  const lookup = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${lookup("year")}-${lookup("month")}-${lookup("day")}`;
}

/** Whole calendar days between two `YYYY-MM-DD` keys. Zone-free by construction. */
function daysBetween(fromKey: string, toKey: string): number {
  return Math.round(
    (Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / MS_PER_DAY,
  );
}

/** The `YYYY-MM-DD` `days` after this one. Date-only arithmetic; no zone involved. */
function addDays(dayKey: string, days: number): string {
  return new Date(Date.parse(`${dayKey}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The UTC instant of `handoffTime` on a calendar day in the schedule's zone. */
function handoffInstant(schedule: OnCallSchedule, dayKey: string): number {
  const [hour, minute] = schedule.handoffTime.split(":").map(Number) as [number, number];
  const [year, month, day] = dayKey.split("-").map(Number) as [number, number, number];
  return wallTimeToUtc(schedule.timezone, year, month, day, hour, minute);
}

/**
 * Which shift index covers an instant, and the calendar day that shift began on.
 *
 * The day a shift belongs to is decided by the handover time, not by midnight:
 * at 08:00 on a Monday with a 09:00 handover, last week's shift is still
 * running. Returns null before the schedule's start date — a rotation does not
 * retroactively cover the past.
 */
function shiftIndexAt(
  schedule: OnCallSchedule,
  atMs: number,
): { index: number; startDay: string } | null {
  const dayKey = zonedDayKey(atMs, schedule.timezone);
  // Before the handover, the day still belongs to the previous one.
  const effectiveDay = atMs < handoffInstant(schedule, dayKey) ? addDays(dayKey, -1) : dayKey;
  const elapsed = daysBetween(schedule.startDate, effectiveDay);
  if (elapsed < 0) return null;
  const index = Math.floor(elapsed / schedule.rotationDays);
  return { index, startDay: addDays(schedule.startDate, index * schedule.rotationDays) };
}

function participantAt(schedule: OnCallSchedule, index: number): OnCallParticipant | null {
  if (schedule.participants.length === 0) return null;
  return schedule.participants[index % schedule.participants.length] ?? null;
}

/**
 * Who is on call at an instant.
 *
 * An override that covers the instant wins outright; among several, the one
 * that **started most recently** wins, so a later-written cover supersedes an
 * earlier overlapping one rather than the answer depending on row order.
 *
 * Returns null for a disabled schedule, a schedule with nobody in it, or an
 * instant before the rotation starts. Every caller treats null as "this
 * destination contributes nobody" and carries on with the rule's other
 * destinations — an alert that fails to deliver because a schedule was
 * misconfigured is the worst possible failure for this feature.
 */
export function resolveOnCall(
  schedule: OnCallSchedule,
  overrides: readonly OnCallOverride[],
  atMs: number,
): OnCallShift | null {
  if (!schedule.enabled) return null;

  const covering = overrides
    .filter((o) => o.scheduleId === schedule.id)
    .filter((o) => {
      const start = Date.parse(o.startsAt);
      const end = Date.parse(o.endsAt);
      return !Number.isNaN(start) && !Number.isNaN(end) && start <= atMs && atMs < end;
    })
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));

  const override = covering[0];
  if (override) {
    return {
      startsAt: override.startsAt,
      endsAt: override.endsAt,
      userId: override.userId,
      name: override.userName,
      email: null,
      source: "override",
      rotationIndex: null,
    };
  }

  const position = shiftIndexAt(schedule, atMs);
  if (!position) return null;
  const participant = participantAt(schedule, position.index);
  if (!participant) return null;

  return {
    startsAt: new Date(handoffInstant(schedule, position.startDay)).toISOString(),
    endsAt: new Date(
      handoffInstant(schedule, addDays(position.startDay, schedule.rotationDays)),
    ).toISOString(),
    userId: participant.userId,
    name: participant.name,
    email: participant.email,
    source: "rotation",
    rotationIndex: position.index % schedule.participants.length,
  };
}

/**
 * The person after the one currently on call — where an escalation goes.
 *
 * Resolved from the *rotation*, never from an override: a cover is somebody
 * standing in for one shift, and escalating to "whoever happens to be covering
 * next Tuesday" is not what an escalation means. Returns null when the rotation
 * has fewer than two people, in which case the escalation has nowhere to go and
 * the caller falls back to the rule's own escalation destinations.
 */
export function nextOnCall(schedule: OnCallSchedule, atMs: number): OnCallParticipant | null {
  if (!schedule.enabled || schedule.participants.length < 2) return null;
  const position = shiftIndexAt(schedule, atMs);
  if (!position) return null;
  return participantAt(schedule, position.index + 1);
}

/**
 * Upcoming shifts, for the editor's preview and the schedule page.
 *
 * Rotation shifts only — overrides are drawn over them by the caller, because
 * a preview that silently folded covers in would make it impossible to see
 * what the rotation itself does.
 */
export function upcomingOnCallShifts(
  schedule: OnCallSchedule,
  fromMs: number,
  count: number,
): OnCallShift[] {
  if (!schedule.enabled || schedule.participants.length === 0) return [];
  const capped = Math.max(0, Math.min(count, ON_CALL_LIMITS.maxPreviewShifts));
  const position = shiftIndexAt(schedule, fromMs);
  // Before the rotation starts, preview from its first shift rather than
  // returning nothing: a schedule dated next Monday should still show what it
  // is going to do.
  const firstIndex = position?.index ?? 0;
  const firstDay = position?.startDay ?? schedule.startDate;

  const shifts: OnCallShift[] = [];
  for (let step = 0; step < capped; step += 1) {
    const startDay = addDays(firstDay, step * schedule.rotationDays);
    const participant = participantAt(schedule, firstIndex + step);
    if (!participant) break;
    shifts.push({
      startsAt: new Date(handoffInstant(schedule, startDay)).toISOString(),
      endsAt: new Date(
        handoffInstant(schedule, addDays(startDay, schedule.rotationDays)),
      ).toISOString(),
      userId: participant.userId,
      name: participant.name,
      email: participant.email,
      source: "rotation",
      rotationIndex: (firstIndex + step) % schedule.participants.length,
    });
  }
  return shifts;
}

/** Validate a cover window. One sentence, or null. */
export function validateOnCallOverride(input: {
  userId: string;
  startsAt: string;
  endsAt: string;
  reason?: string | null;
}): string | null {
  if (!input.userId) return "Choose who is covering.";
  const start = Date.parse(input.startsAt);
  const end = Date.parse(input.endsAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return "The cover needs a start and an end.";
  if (end <= start) return "The cover must end after it starts.";
  if (end - start > ON_CALL_LIMITS.maxOverrideDays * MS_PER_DAY) {
    return `A cover may run for at most ${ON_CALL_LIMITS.maxOverrideDays} days. For anything longer, change the rotation.`;
  }
  if ((input.reason?.length ?? 0) > ON_CALL_LIMITS.maxReasonLength) {
    return `The reason must be ${ON_CALL_LIMITS.maxReasonLength} characters or fewer.`;
  }
  return null;
}
