/**
 * Period and schedule arithmetic for scheduled cost exports.
 *
 * Pure functions over civil (wall-clock) dates in an IANA zone — no database,
 * no ClickHouse — so the two rules that make an export reconcilable can be
 * tested directly:
 *
 *   1. **One object per period, always written whole.** A run that re-exports
 *      a period because of a restatement re-emits *every* day of it, not just
 *      the days inside the restatement window. The object key is derived from
 *      the period start alone, so writing it again overwrites the previous
 *      copy; a partial rewrite would silently truncate the period a consumer
 *      already loaded.
 *   2. **Today is never a period end.** Runs export through *yesterday* in the
 *      export's own timezone. The current day's spend does not exist at any
 *      provider yet, and an object that is empty on Monday and full on Tuesday
 *      is worse than no object at all.
 */
import { addDays, civilMoment, isValidTimeZone } from "../digest/compose";

export type CostExportCadence = "daily" | "weekly" | "monthly";

/** One object's worth of days. `from`/`to` are inclusive ISO `YYYY-MM-DD`. */
export interface CostExportPeriod {
  /**
   * The period's first day, and the only thing the object key varies on. Using
   * the start *date* for all three cadences (rather than `2026-W32` / `2026-08`
   * forms) keeps keys lexicographically sortable and means a consumer never has
   * to know ISO week numbering to find last week's file.
   */
  key: string;
  from: string;
  to: string;
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a civil date. Pure calendar math. */
function isoDowOf(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map((n) => Number.parseInt(n, 10));
  // Date.UTC as a calendar calculator only; no instant is derived from it.
  const dow = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** The whole period of `cadence` that contains `isoDate`. */
export function periodContaining(cadence: CostExportCadence, isoDate: string): CostExportPeriod {
  switch (cadence) {
    case "daily":
      return { key: isoDate, from: isoDate, to: isoDate };
    case "weekly": {
      const from = addDays(isoDate, -(isoDowOf(isoDate) - 1));
      return { key: from, from, to: addDays(from, 6) };
    }
    case "monthly": {
      const from = `${isoDate.slice(0, 7)}-01`;
      // First of the next month, minus a day — avoids a month-length table.
      const [y, m] = from.split("-").map((n) => Number.parseInt(n, 10));
      const nextMonth =
        (m ?? 1) === 12
          ? `${(y ?? 1970) + 1}-01-01`
          : `${y}-${String((m ?? 1) + 1).padStart(2, "0")}-01`;
      return { key: from, from, to: addDays(nextMonth, -1) };
    }
  }
}

/** The period immediately after `period`. */
export function nextPeriod(cadence: CostExportCadence, period: CostExportPeriod): CostExportPeriod {
  return periodContaining(cadence, addDays(period.to, 1));
}

export interface PeriodWindowOptions {
  cadence: CostExportCadence;
  timezone: string;
  /** Trailing days of already-written periods to re-export. 0–90. */
  restatementDays: number;
  now: Date;
}

/**
 * Which periods a run happening at `now` should write.
 *
 * The window is `[yesterday - restatementDays, yesterday]` in the export's own
 * timezone, and every period *overlapping* it is emitted **in full**. That is
 * why a monthly export with a 7-day restatement window re-writes all of last
 * month on the 3rd: seven days back reaches into July, so July's object is
 * rebuilt from July's restated rows rather than left holding the numbers that
 * were true on the 1st.
 *
 * `restatementDays: 0` degenerates to "just the period containing yesterday",
 * which is the no-restatement behaviour — correct only for an org whose
 * providers never revise, and the reason the field defaults to 7 instead.
 *
 * Periods come back oldest-first so a consumer watching the destination sees
 * history settle before it sees the newest period appear.
 */
export function periodsToExport(opts: PeriodWindowOptions): CostExportPeriod[] {
  const { date: today } = civilMoment(opts.now, opts.timezone);
  const windowEnd = addDays(today, -1);
  const clamped = Math.max(0, Math.min(90, Math.trunc(opts.restatementDays)));
  const windowStart = addDays(windowEnd, -clamped);

  const periods: CostExportPeriod[] = [];
  let period = periodContaining(opts.cadence, windowStart);
  // Bounded by construction: the window is at most 91 days, so this is at most
  // 91 daily / 14 weekly / 5 monthly iterations. The guard is belt-and-braces
  // against a malformed cadence rather than a real limit.
  for (let i = 0; i < 128 && period.from <= windowEnd; i++) {
    periods.push({
      key: period.key,
      from: period.from,
      // A period still in progress is exported up to yesterday. Its key does
      // not change, so tomorrow's run replaces it with a longer version of the
      // same object — that is the mechanism, not a special case.
      to: period.to < windowEnd ? period.to : windowEnd,
    });
    period = nextPeriod(opts.cadence, period);
  }
  return periods;
}

/**
 * Offset between `tz` wall-clock and UTC at `instant`, in milliseconds.
 * Positive east of Greenwich. Derived by formatting the instant in the zone and
 * reading the result back as if it were UTC — the platform's tz database is the
 * only source of truth here, and the repo has no date library to reuse.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number.parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asIfUtc - instant.getTime();
}

/**
 * The instant at which `isoDate` `hour`:00 occurs in `timeZone`.
 *
 * Two passes: guess the instant assuming UTC, look up the zone's offset at that
 * guess, correct, then look up again in case the correction crossed a DST
 * boundary. On the "spring forward" hour, which does not exist locally, this
 * lands on the instant the clock jumps to — an hour later than asked, which for
 * a nightly export is the right kind of wrong.
 */
export function zonedInstant(isoDate: string, hour: number, timeZone: string): Date {
  const [y, m, d] = isoDate.split("-").map((n) => Number.parseInt(n, 10));
  const wall = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, hour);
  let ts = wall;
  for (let i = 0; i < 2; i++) {
    ts = wall - zoneOffsetMs(new Date(ts), timeZone);
  }
  return new Date(ts);
}

/**
 * When the next run of this schedule is due, strictly after `from`.
 *
 * Walks forward a local day at a time and takes the first day the cadence fires
 * on (any day / Monday / the 1st) whose local `hour` has not already passed.
 * Day-stepping rather than instant arithmetic is what keeps this correct across
 * DST: 04:00 local stays 04:00 local through the change, which is what the user
 * asked for, where "+24h" would drift to 03:00 or 05:00.
 */
export function nextCostExportRunAt(
  cadence: CostExportCadence,
  hour: number,
  timezone: string,
  from: Date,
): Date {
  const tz = isValidTimeZone(timezone) ? timezone : "UTC";
  const start = civilMoment(from, tz).date;
  // 40 days covers the longest gap any cadence here can have (a month) with
  // room for the search starting the day after a fire.
  for (let i = 0; i <= 40; i++) {
    const date = addDays(start, i);
    if (cadence === "weekly" && isoDowOf(date) !== 1) continue;
    if (cadence === "monthly" && !date.endsWith("-01")) continue;
    const instant = zonedInstant(date, hour, tz);
    if (instant.getTime() > from.getTime()) return instant;
  }
  // Unreachable for the three cadences; a day is a safe fallback rather than a
  // throw, because this is called from the poller.
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}
