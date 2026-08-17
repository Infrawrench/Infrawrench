/**
 * The operations calendar — one time axis over every dated thing the org
 * already keeps somewhere else.
 *
 * Nothing here is a new record. A change freeze, a sleep window, a certificate
 * deadline, a reservation's term end, a cron-scheduled workflow and a declared
 * incident are all *already* stored; what has never existed is a place to see
 * them beside one another, which is the question people actually ask ("is
 * anything happening next Tuesday?"). So the calendar is a projection, computed
 * on read the way the posture and backup feeds are, and this module holds the
 * half of it that is pure: the event shape all three surfaces agree on, the
 * window expansion for recurring schedules, the day bucketing, the month grid,
 * and the iCalendar serializer.
 *
 * The serializer lives here rather than in the server because RFC 5545 is
 * fiddly in exactly the ways a unit test catches — octet-counted line folding,
 * escaping of `,` `;` `\` and newlines, UTC stamps with no separators — and a
 * subscription URL that renders as garbage in one calendar client and fine in
 * another is the sort of bug you only find months later.
 */

/**
 * What a calendar event came from. The kinds are deliberately the *sources*
 * rather than a normalized severity taxonomy: a reader scanning the month wants
 * "that's a freeze" and "that's a cert", and the filter chips are the kinds.
 */
export type CalendarEventKind =
  | "change-freeze"
  | "sleep-schedule"
  | "expiry"
  | "commitment-expiry"
  | "workflow-schedule"
  | "incident";

export const CALENDAR_EVENT_KINDS: readonly CalendarEventKind[] = [
  "change-freeze",
  "sleep-schedule",
  "expiry",
  "commitment-expiry",
  "workflow-schedule",
  "incident",
] as const;

/** How loudly the event should read. Three levels, matching the expiry feed. */
export type CalendarEventSeverity = "critical" | "warning" | "info";

/**
 * Where clicking the event should go.
 *
 * A hint, not a route: the two hosts address their pages differently (desktop
 * by search param, web by path segment), so the calendar names the destination
 * and each host's panel turns it into navigation. `resource` carries the pair
 * every resource tab needs; `tab` names a workspace tab kind the host already
 * knows how to open.
 */
export type CalendarEventLink =
  | { target: "resource"; accountId: string; resourceId: string }
  | { target: "tab"; tab: "expiring" | "incidents" | "workflows" | "costs" | "settings" };

export interface CalendarEvent {
  /**
   * Stable across renders for the same underlying thing, because it becomes
   * the iCalendar UID: a subscribed client that sees the UID change treats the
   * event as deleted and re-created, which is how a calendar ends up with
   * duplicate entries after every refresh. Derived from the source row's id
   * (plus the occurrence instant, for recurring sources), never from an index.
   */
  id: string;
  kind: CalendarEventKind;
  title: string;
  /** One sentence of context, or null when the title says everything. */
  detail: string | null;
  /** ISO 8601, UTC. */
  startsAt: string;
  /**
   * ISO 8601, UTC. Null means a point in time rather than a span — a deadline,
   * a scheduled run. An open-ended span (a freeze with no end) reports its
   * `endsAt` as null too, and `openEnded` distinguishes the two.
   */
  endsAt: string | null;
  /**
   * True when the event has a span but no known end — a freeze declared
   * "until further notice", an unresolved incident. Rendered as running to the
   * edge of the view rather than as a moment.
   */
  openEnded: boolean;
  /**
   * True for deadlines that are only meaningful to the day — a certificate
   * expiry read off a date field. Point events with a real clock time (a
   * scheduled workflow run) are not all-day.
   */
  allDay: boolean;
  severity: CalendarEventSeverity;
  link: CalendarEventLink | null;
}

export interface CalendarResponse {
  events: CalendarEvent[];
  /** Inclusive lower bound of the window the events were computed for. */
  from: string;
  /** Exclusive upper bound. */
  to: string;
  /**
   * Kinds that were asked for and produced no events in this window. Lets the
   * filter chips read "nothing scheduled" rather than leaving an empty chip
   * looking broken — and, paired with `failedKinds`, keeps "there is none" and
   * "we could not read it" from looking alike.
   */
  emptyKinds: CalendarEventKind[];
  /**
   * Sources that threw. Named rather than swallowed: a calendar is a summary
   * surface, so one failing source must cost its own kind and not the page —
   * and a page that quietly drops a source is worse than one that says it did.
   */
  failedKinds: CalendarEventKind[];
  generatedAt: string;
}

/** A calendar subscription — one iCalendar URL, revocable. */
export interface CalendarSubscription {
  id: string;
  name: string;
  /** Kinds the feed carries; empty means every kind. */
  kinds: CalendarEventKind[];
  /**
   * Only ever returned once, by the create call. The stored form is a hash —
   * the token is the sole credential on an unauthenticated URL, so it follows
   * the API-key stance rather than the "show it again" stance.
   */
  url?: string;
  createdAt: string;
  lastAccessedAt: string | null;
  revokedAt: string | null;
}

export interface CalendarSubscriptionInput {
  name: string;
  kinds?: CalendarEventKind[];
}

const MS_PER_DAY = 86_400_000;

/**
 * How far a subscription feed looks in each direction. Deliberately asymmetric:
 * a calendar client wants a little history for context and a lot of future,
 * and the whole point of the feed is the future.
 */
export const ICS_WINDOW_PAST_DAYS = 30;
export const ICS_WINDOW_FUTURE_DAYS = 180;

/**
 * The widest window a caller may ask the API for. A year of sleep-schedule
 * transitions across a few hundred resources is tens of thousands of events;
 * the cap is what keeps a mistyped `to=2099` from turning into an OOM.
 */
export const CALENDAR_MAX_WINDOW_DAYS = 400;

/** Per-source occurrence cap, so one pathological schedule cannot flood a month. */
export const CALENDAR_MAX_OCCURRENCES_PER_SOURCE = 400;

function isValidKind(value: unknown): value is CalendarEventKind {
  return typeof value === "string" && (CALENDAR_EVENT_KINDS as readonly string[]).includes(value);
}

/**
 * Narrow an untrusted `kinds` list — a query parameter, a stored subscription
 * row — to the kinds this build knows. Unknown members are dropped rather than
 * rejected: a subscription written by a newer server must keep working against
 * an older one, and a URL a calendar client refreshes hourly is the worst place
 * to start returning 400.
 */
export function parseCalendarKinds(value: unknown): CalendarEventKind[] {
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const seen = new Set<CalendarEventKind>();
  for (const entry of raw) {
    const trimmed = typeof entry === "string" ? entry.trim() : entry;
    if (isValidKind(trimmed)) seen.add(trimmed);
  }
  return CALENDAR_EVENT_KINDS.filter((kind) => seen.has(kind));
}

/** A half-open span, epoch ms. */
export interface TimeWindow {
  from: number;
  to: number;
}

/**
 * Does `[start, end)` overlap the window?
 *
 * A null `end` means **a point in time** — a deadline, a scheduled run — and
 * not an open-ended span. A span with no known end has to say so by passing
 * `Number.POSITIVE_INFINITY`, because the two readings genuinely differ: a
 * freeze declared until further notice overlaps every future window, while a
 * deadline that has passed overlaps none of them.
 */
export function overlapsWindow(start: number, end: number | null, window: TimeWindow): boolean {
  const finish = end ?? start;
  // Half-open on both sides, except that a point exactly at `from` counts —
  // otherwise a deadline at midnight vanishes from the day it falls on.
  return start < window.to && (finish > window.from || start >= window.from);
}

export interface SleepWindow {
  /** When the resource goes down, ISO 8601. */
  startsAt: string;
  /** When it comes back, ISO 8601; null when that is past the search horizon. */
  endsAt: string | null;
}

interface SleepTransition {
  at: string;
  action: "stop" | "start";
}

/**
 * Pair a schedule's stop/start transitions into the spans the resource is
 * actually down for.
 *
 * The input is whatever `computeUpcomingTransitions` produced (the same
 * function the schedule editor previews with, so the calendar and the form
 * cannot disagree about when a window opens). The pairing is the part worth
 * testing: a window that *starts* before the search began still has to appear,
 * so a leading `start` with no matching `stop` is treated as the tail of a span
 * that opened earlier, and a trailing `stop` with no matching `start` is
 * reported open-ended rather than dropped.
 */
export function pairSleepWindows(transitions: SleepTransition[]): SleepWindow[] {
  const windows: SleepWindow[] = [];
  let openedAt: string | null = null;
  for (const transition of transitions) {
    if (transition.action === "stop") {
      // Two stops in a row cannot happen from a valid timing, but if they did,
      // keeping the earlier one is the reading that over-reports downtime —
      // the safe direction for a screen people plan maintenance against.
      openedAt ??= transition.at;
      continue;
    }
    if (openedAt !== null) {
      windows.push({ startsAt: openedAt, endsAt: transition.at });
      openedAt = null;
    }
  }
  if (openedAt !== null) windows.push({ startsAt: openedAt, endsAt: null });
  return windows;
}

/**
 * `YYYY-MM-DD` for an instant in a named zone.
 *
 * `Intl.DateTimeFormat` with an explicit `timeZone` is the only correct way to
 * do this — adding an offset to a UTC date is wrong twice a year, and wrong by
 * a whole day for anyone east of UTC+12 every day.
 */
export function calendarDayKey(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const lookup = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${lookup("year")}-${lookup("month")}-${lookup("day")}`;
}

/** The `YYYY-MM-DD` after this one. Date-only arithmetic, so no zone is involved. */
function nextDayKey(key: string): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Bucket events by the day they touch, in the reader's zone.
 *
 * A span occupies every day it covers, not just the one it starts on — the
 * whole value of a freeze on a calendar is seeing it sit across the week.
 *
 * The walk is over *date strings* between the start's day and the end's day,
 * not over instants: stepping the instant by 24 hours skips a date every
 * spring-forward (23:30 UTC on the 26th and the 27th are both late evening in
 * London, but 23:30 UTC on the 28th is already 00:30 on the 29th) and repeats
 * one every autumn. The two endpoints are resolved with `Intl` and everything
 * between them is plain calendar counting, which has no such failure mode. The
 * expansion is capped at `CALENDAR_MAX_WINDOW_DAYS` so an open-ended span the
 * caller forgot to clamp cannot walk forever.
 */
export function groupCalendarEventsByDay(
  events: CalendarEvent[],
  timeZone: string,
): Map<string, CalendarEvent[]> {
  const byDay = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const start = new Date(event.startsAt).getTime();
    if (Number.isNaN(start)) continue;
    const endValue = event.endsAt === null ? start : new Date(event.endsAt).getTime();
    const end = Number.isNaN(endValue) ? start : Math.max(start, endValue);
    const firstKey = calendarDayKey(event.startsAt, timeZone);
    const lastKey = calendarDayKey(new Date(end).toISOString(), timeZone);
    if (!firstKey || !lastKey) continue;
    let key = firstKey;
    for (let days = 0; days <= CALENDAR_MAX_WINDOW_DAYS; days += 1) {
      const bucket = byDay.get(key);
      if (bucket) bucket.push(event);
      else byDay.set(key, [event]);
      if (key >= lastKey) break;
      key = nextDayKey(key);
    }
  }
  return byDay;
}

/**
 * The 6×7 grid of `YYYY-MM-DD` keys a month view draws, Monday-first.
 *
 * Always six rows, never five: a grid that changes height between months makes
 * the whole page jump, and the trailing row is where the first days of the next
 * month go. Built from UTC arithmetic on a date-only anchor, which is safe
 * precisely because there is no time of day involved.
 */
export function calendarMonthGrid(year: number, month: number): string[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  // getUTCDay is Sunday-0; the grid is Monday-first, so Sunday lands last.
  const leading = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.getTime() - leading * MS_PER_DAY);
  const weeks: string[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const row: string[] = [];
    for (let day = 0; day < 7; day += 1) {
      const cell = new Date(start.getTime() + (week * 7 + day) * MS_PER_DAY);
      row.push(cell.toISOString().slice(0, 10));
    }
    weeks.push(row);
  }
  return weeks;
}

/** Sort key: earlier first, then longer spans first, then by id for stability. */
export function compareCalendarEvents(a: CalendarEvent, b: CalendarEvent): number {
  const byStart = a.startsAt.localeCompare(b.startsAt);
  if (byStart !== 0) return byStart;
  const aEnd = a.endsAt ?? a.startsAt;
  const bEnd = b.endsAt ?? b.startsAt;
  const byEnd = bEnd.localeCompare(aEnd);
  if (byEnd !== 0) return byEnd;
  return a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------------
// iCalendar (RFC 5545)
// ---------------------------------------------------------------------------

/**
 * Escape a value for a `TEXT` property: backslash first (or it would double the
 * escapes it just inserted), then the separators, then newlines — which RFC
 * 5545 spells `\n` rather than allowing a literal line break, since a bare
 * newline is how a property ends.
 */
export function icsEscapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Fold a content line to 75 **octets**, continuing with CRLF + one space.
 *
 * Octets, not characters: the limit is on the encoded line, and folding a
 * multi-byte character in half produces a line no parser can decode. The
 * accumulator therefore measures UTF-8 length per code point and never splits
 * one — surrogate pairs included, which is why the loop walks `[...value]`
 * rather than indexing.
 */
export function foldIcsLine(value: string): string {
  const encoder = new TextEncoder();
  const lines: string[] = [];
  let current = "";
  let currentBytes = 0;
  // The continuation space counts against the 75, so every line after the
  // first has 74 octets of room.
  for (const char of value) {
    const size = encoder.encode(char).length;
    const limit = lines.length === 0 ? 75 : 74;
    if (currentBytes + size > limit) {
      lines.push(current);
      current = "";
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  lines.push(current);
  return lines.map((line, index) => (index === 0 ? line : ` ${line}`)).join("\r\n");
}

/** `20260817T134500Z` — the UTC form, which is the only one we ever emit. */
export function icsTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** `20260817` — the DATE form, for all-day events. */
export function icsDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export interface IcsCalendarOptions {
  /** Calendar name shown in the subscriber's sidebar. */
  name: string;
  /** Stamp written to every event's DTSTAMP; fixed in tests. */
  now: string;
  /** Domain used to build UIDs, so they are globally unique per RFC 5545. */
  uidDomain?: string;
}

/**
 * Serialize events as an iCalendar document.
 *
 * Two properties do the real work for subscribers. `UID` is derived from the
 * event's own stable id, so a refresh updates an event rather than replacing
 * it; and `X-PUBLISHED-TTL` / `REFRESH-INTERVAL` ask clients not to poll harder
 * than hourly, because an unauthenticated URL is exactly the sort of thing a
 * hundred phones hit every five minutes otherwise.
 *
 * All-day events get `VALUE=DATE` with an exclusive `DTEND` of the next day —
 * the RFC's rule, and the one every client gets wrong if you omit the DTEND.
 */
export function buildIcsCalendar(events: CalendarEvent[], options: IcsCalendarOptions): string {
  const domain = options.uidDomain ?? "infrawrench.com";
  const stamp = icsTimestamp(options.now);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Infrawrench//Operations Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscapeText(options.name)}`,
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];

  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${icsEscapeText(event.id)}@${domain}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (event.allDay) {
      const start = new Date(event.startsAt);
      lines.push(`DTSTART;VALUE=DATE:${icsDate(event.startsAt)}`);
      // Exclusive end: a one-day event ends on the following date.
      const end = new Date((event.endsAt ? new Date(event.endsAt) : start).getTime() + MS_PER_DAY);
      lines.push(`DTEND;VALUE=DATE:${icsDate(end.toISOString())}`);
    } else {
      lines.push(`DTSTART:${icsTimestamp(event.startsAt)}`);
      if (event.endsAt) lines.push(`DTEND:${icsTimestamp(event.endsAt)}`);
    }
    lines.push(`SUMMARY:${icsEscapeText(event.title)}`);
    if (event.detail) lines.push(`DESCRIPTION:${icsEscapeText(event.detail)}`);
    lines.push(`CATEGORIES:${icsEscapeText(event.kind)}`);
    // An unresolved incident and a running freeze are the two things a reader
    // wants to see as "happening", which is what TRANSP:OPAQUE means to a
    // calendar's free/busy view.
    lines.push(event.endsAt || event.openEnded ? "TRANSP:OPAQUE" : "TRANSP:TRANSPARENT");
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  // CRLF, per the RFC — some clients accept bare LF, and the ones that do not
  // fail by showing an empty calendar with no error.
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}
