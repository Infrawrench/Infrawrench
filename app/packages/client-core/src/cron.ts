/**
 * Minimal hand-rolled cron engine shared by every host that schedules or
 * previews workflow cron triggers: the cloud poller (fires due schedules), the
 * web API (validates expressions and computes `next_run_at` on save), the
 * desktop app's local cron runner, and the shared trigger editor (next-run
 * preview). One implementation means the preview a user sees is computed by
 * exactly the same code that later fires the run.
 *
 * Supported syntax — standard 5-field cron (minute hour day-of-month month
 * day-of-week): `*`, lists (`1,15,30`), ranges (`9-17`), steps (`*&#47;5`,
 * `9-17/2`, `3/4`), 3-letter month/weekday names (`JAN`, `MON`), and `7` as
 * Sunday. Vixie/POSIX day matching: when both day-of-month and day-of-week are
 * restricted, a date matches if *either* does.
 *
 * Timezones use IANA zone names resolved through `Intl` (available in every
 * host: browsers, Node, Electron). Occurrences are found by searching wall-
 * clock time in the zone and converting back to an instant, so DST is handled
 * the way cron daemons handle it: wall times skipped by spring-forward don't
 * fire, and during fall-back's repeated hour the earlier instant is chosen.
 *
 * Deliberately dependency-free and pure — no Date.now() reads, no I/O.
 */

/** One parsed 5-field expression. Values are wall-clock components. */
export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  /** Days of month, 1-31. */
  daysOfMonth: Set<number>;
  /** Months, 1-12. */
  months: Set<number>;
  /** Days of week, 0-6 with 0 = Sunday (7 in the source is normalized to 0). */
  daysOfWeek: Set<number>;
  /** Whether the day-of-month field was something other than `*`. */
  domRestricted: boolean;
  /** Whether the day-of-week field was something other than `*`. */
  dowRestricted: boolean;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  names?: Record<string, number>;
  /** Normalize an in-range value (day-of-week folds 7 onto Sunday). */
  fold?: (n: number) => number;
}

const FIELD_SPECS: [FieldSpec, FieldSpec, FieldSpec, FieldSpec, FieldSpec] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day-of-month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12, names: MONTH_NAMES },
  { label: "day-of-week", min: 0, max: 7, names: DOW_NAMES, fold: (n) => n % 7 },
];

/** Resolve one range endpoint: a number or a 3-letter name. */
function parseValue(token: string, spec: FieldSpec): number {
  const named = spec.names?.[token.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) {
    throw new Error(`Invalid ${spec.label} value "${token}"`);
  }
  const n = Number(token);
  if (n < spec.min || n > spec.max) {
    throw new Error(
      `${capitalize(spec.label)} value ${n} is out of range (${spec.min}-${spec.max})`,
    );
  }
  return n;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Parse one field ("*", lists, ranges, steps) into its value set. */
function parseField(field: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const item of field.split(",")) {
    if (item === "") throw new Error(`Empty list item in ${spec.label} field "${field}"`);
    const slashParts = item.split("/");
    const body = slashParts[0] ?? "";
    const stepStr = slashParts[1];
    if (slashParts.length > 2 || stepStr === "") {
      throw new Error(`Invalid step in ${spec.label} field "${item}"`);
    }
    let step = 1;
    if (stepStr !== undefined) {
      if (!/^\d+$/.test(stepStr) || Number(stepStr) === 0) {
        throw new Error(`Invalid step "/${stepStr}" in ${spec.label} field`);
      }
      step = Number(stepStr);
    }

    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = spec.min;
      hi = spec.max;
    } else if (body.includes("-")) {
      const [a, b, more] = body.split("-");
      if (!a || !b || more !== undefined) {
        throw new Error(`Invalid range "${body}" in ${spec.label} field`);
      }
      lo = parseValue(a, spec);
      hi = parseValue(b, spec);
      if (lo > hi) {
        throw new Error(
          `Range "${body}" in ${spec.label} field is reversed (${lo} > ${hi}); wrapping ranges aren't supported`,
        );
      }
    } else {
      lo = parseValue(body, spec);
      // `N/step` means "from N to max, every step" (Vixie extension);
      // a bare `N` is just N.
      hi = stepStr !== undefined ? spec.max : lo;
    }

    for (let v = lo; v <= hi; v += step) {
      values.add(spec.fold ? spec.fold(v) : v);
    }
  }
  return values;
}

/**
 * Parse a 5-field cron expression. Throws an `Error` with a user-facing
 * message when the expression is malformed.
 */
export function parseCronExpression(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Expected 5 fields (minute hour day month weekday), got ${fields.length === 1 && fields[0] === "" ? 0 : fields.length}`,
    );
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = FIELD_SPECS.map((spec, i) =>
    parseField(fields[i] as string, spec),
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    // Vixie semantics: a field beginning with `*` (including `*/2`) keeps its
    // star flag, so it doesn't participate in the dom/dow either-matches rule.
    domRestricted: !(fields[2] as string).startsWith("*"),
    dowRestricted: !(fields[4] as string).startsWith("*"),
  };
}

/** `null` when the expression parses, else the parse error's message. */
export function validateCronExpression(expression: string): string | null {
  try {
    parseCronExpression(expression);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Whether `Intl` recognises the given IANA timezone name. */
export function isValidCronTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

// --- Timezone plumbing -----------------------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let dtf = formatterCache.get(zone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(zone, dtf);
  }
  return dtf;
}

interface WallParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
}

/** The wall-clock components of a UTC instant in a zone. */
function wallPartsAt(zone: string | undefined, utcMs: number): WallParts {
  if (!zone) {
    const d = new Date(utcMs);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
    };
  }
  const parts: Record<string, number> = {};
  for (const p of formatterFor(zone).formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts["year"] ?? 0,
    month: parts["month"] ?? 1,
    day: parts["day"] ?? 1,
    hour: parts["hour"] ?? 0,
    minute: parts["minute"] ?? 0,
  };
}

/** The zone's UTC offset (ms, east-positive) at a UTC instant. */
function zoneOffsetMs(zone: string, utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(zone).formatToParts(new Date(utcMs))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const wallAsUtc = Date.UTC(
    parts["year"] ?? 0,
    (parts["month"] ?? 1) - 1,
    parts["day"] ?? 1,
    parts["hour"] ?? 0,
    parts["minute"] ?? 0,
    parts["second"] ?? 0,
  );
  return wallAsUtc - utcMs;
}

/**
 * The UTC instant whose wall clock in `zone` reads `wallMs` (a Date.UTC value
 * built from wall components). Returns the earlier instant when the wall time
 * occurs twice (DST fall-back) and `null` when it never occurs (spring-forward
 * gap).
 */
function wallToUtc(zone: string, wallMs: number): number | null {
  // Candidate offsets: sample the zone a day either side of the target so both
  // sides of any transition are represented.
  const dayMs = 24 * 60 * 60 * 1000;
  const offsets = new Set<number>([
    zoneOffsetMs(zone, wallMs - dayMs),
    zoneOffsetMs(zone, wallMs),
    zoneOffsetMs(zone, wallMs + dayMs),
  ]);
  let best: number | null = null;
  for (const off of offsets) {
    const t = wallMs - off;
    if (zoneOffsetMs(zone, t) === off && (best === null || t < best)) best = t;
  }
  return best;
}

// --- Next-occurrence search ------------------------------------------------

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Weekday (0 = Sunday) of a wall-clock date; zone-independent. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function dayMatches(cron: ParsedCron, year: number, month: number, day: number): boolean {
  const domOk = cron.daysOfMonth.has(day);
  const dowOk = cron.daysOfWeek.has(weekdayOf(year, month, day));
  // POSIX: when both fields are restricted, either one matching is a match.
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

/** How many years past `from` to search before declaring "never". */
const MAX_YEARS_AHEAD = 5;

export interface CronOccurrenceOptions {
  /** Search strictly after this instant. Defaults to now. */
  from?: Date;
  /** IANA zone the expression's wall times are in. Defaults to UTC. */
  timezone?: string;
}

/**
 * The next instant strictly after `from` matching the expression, or `null`
 * when no wall time within {@link MAX_YEARS_AHEAD} years matches (e.g.
 * `0 0 30 2 *`). Throws on an unparseable expression or unknown timezone.
 */
export function nextCronOccurrence(
  expression: string | ParsedCron,
  options: CronOccurrenceOptions = {},
): Date | null {
  const cron = typeof expression === "string" ? parseCronExpression(expression) : expression;
  const zone = options.timezone || undefined;
  if (zone && !isValidCronTimezone(zone)) {
    throw new Error(`Unknown timezone "${zone}"`);
  }
  const fromMs = (options.from ?? new Date()).getTime();

  // Cursor is a wall-clock time in the zone, starting at the minute after
  // `from`. Each loop pass either matches or advances the coarsest mismatched
  // field (resetting finer ones), so sparse schedules take few iterations.
  const cursor = wallPartsAt(zone, fromMs + 60_000);
  const maxYear = cursor.year + MAX_YEARS_AHEAD;

  const nextDay = () => {
    cursor.day += 1;
    cursor.hour = 0;
    cursor.minute = 0;
  };
  const nextMinute = () => {
    cursor.minute += 1;
    if (cursor.minute > 59) {
      cursor.minute = 0;
      cursor.hour += 1;
      if (cursor.hour > 23) nextDay();
    }
  };

  for (let guard = 0; guard < 200_000; guard++) {
    if (cursor.year > maxYear) return null;
    if (cursor.day > daysInMonth(cursor.year, cursor.month)) {
      cursor.day = 1;
      cursor.hour = 0;
      cursor.minute = 0;
      cursor.month += 1;
    }
    if (cursor.month > 12) {
      cursor.month = 1;
      cursor.year += 1;
      cursor.day = 1;
      cursor.hour = 0;
      cursor.minute = 0;
      continue;
    }
    if (!cron.months.has(cursor.month)) {
      cursor.month += 1;
      cursor.day = 1;
      cursor.hour = 0;
      cursor.minute = 0;
      continue;
    }
    if (!dayMatches(cron, cursor.year, cursor.month, cursor.day)) {
      nextDay();
      continue;
    }
    if (!cron.hours.has(cursor.hour)) {
      cursor.hour += 1;
      cursor.minute = 0;
      if (cursor.hour > 23) nextDay();
      continue;
    }
    if (!cron.minutes.has(cursor.minute)) {
      nextMinute();
      continue;
    }

    const wallMs = Date.UTC(cursor.year, cursor.month - 1, cursor.day, cursor.hour, cursor.minute);
    const utc = zone ? wallToUtc(zone, wallMs) : wallMs;
    // `null`: the wall time falls in a DST gap and never happens — skip it,
    // like cron daemons do. `<= fromMs` can occur around fall-back; keep
    // searching forward.
    if (utc === null || utc <= fromMs) {
      nextMinute();
      continue;
    }
    return new Date(utc);
  }
  return null;
}

/**
 * The next `count` occurrences strictly after `options.from` (default: now).
 * Stops early if the schedule runs out of matches.
 */
export function nextCronOccurrences(
  expression: string | ParsedCron,
  count: number,
  options: CronOccurrenceOptions = {},
): Date[] {
  const cron = typeof expression === "string" ? parseCronExpression(expression) : expression;
  const out: Date[] = [];
  let from = options.from ?? new Date();
  for (let i = 0; i < count; i++) {
    const next = nextCronOccurrence(cron, {
      from,
      ...(options.timezone ? { timezone: options.timezone } : {}),
    });
    if (!next) break;
    out.push(next);
    from = next;
  }
  return out;
}
