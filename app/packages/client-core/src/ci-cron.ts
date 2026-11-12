// Matches CI pipelines' `on.schedule` cron expressions on the minute, in
// UTC. The runner's parser (`iwci-spec/src/cron.rs`) is the one that
// validates a pipeline's expressions; this matcher only reads expressions a
// runner already accepted, and follows the same rules: five fields with `*`,
// numbers, ranges, steps and lists, month and weekday names, Sunday as 0 or
// 7, the `@hourly` family, and day-of-month OR day-of-week when both are
// set (only a bare `*` leaves a day field open). `__tests__/ci-cron.test.ts`
// holds the same cases as the Rust tests.
//
// Both things that fire schedules use it: the CI proxy's Cron Trigger
// (repositories registered with it directly) and the app's `ci` poller pass
// (repositories connected through the GitHub App). Workflow cron triggers
// have their own engine (`cron.ts`), with time zones and different rules.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const SHORTCUTS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

function value(text: string, min: number, max: number, names: string[], base: number): number {
  const named = names.indexOf(text.toLowerCase());
  if (named >= 0) return named + base;
  if (!/^\d+$/.test(text)) throw new Error(`\`${text}\` is not a number`);
  const n = Number(text);
  if (n < min || n > max) throw new Error(`${n} is outside ${min}-${max}`);
  return n;
}

function field(
  text: string,
  min: number,
  max: number,
  names: string[] = [],
  base = 0,
): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`\`${stepText}\` is not a step`);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a = "", b = ""] = range.split("-");
      lo = value(a, min, max, names, base);
      hi = value(b, min, max, names, base);
    } else {
      lo = value(range, min, max, names, base);
      hi = step > 1 ? max : lo;
    }
    if (lo > hi) throw new Error(`the range ${lo}-${hi} runs backwards`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface CiCron {
  /** Whether `date`'s minute (UTC) is one the expression fires on. */
  matches(date: Date): boolean;
  /**
   * The first minute strictly after `after` that the expression fires on,
   * or `null` when none falls within five years (`0 0 30 2 *`).
   */
  next(after: Date): Date | null;
}

/** Parses a pipeline's cron expression; throws when the runner would refuse it. */
export function parseCiCron(source: string): CiCron {
  const text = SHORTCUTS[source.trim()] ?? source.trim();
  const fields = text.split(/\s+/);
  if (fields.length !== 5)
    throw new Error(`\`${source}\` has ${fields.length} fields; cron takes 5`);
  const [m = "", h = "", dom = "", mon = "", dow = ""] = fields;
  const minutes = field(m, 0, 59);
  const hours = field(h, 0, 23);
  const days = field(dom, 1, 31);
  const months = field(mon, 1, 12, MONTHS, 1);
  const weekdays = field(dow, 0, 7, WEEKDAYS, 0);
  if (weekdays.has(7)) weekdays.add(0);
  const anyDay = dom === "*";
  const anyWeekday = dow === "*";
  const dayMatches = (date: Date): boolean => {
    const day = days.has(date.getUTCDate());
    const weekday = weekdays.has(date.getUTCDay());
    if (anyDay && anyWeekday) return true;
    if (anyWeekday) return day;
    if (anyDay) return weekday;
    return day || weekday;
  };
  const matches = (date: Date): boolean =>
    minutes.has(date.getUTCMinutes()) &&
    hours.has(date.getUTCHours()) &&
    months.has(date.getUTCMonth() + 1) &&
    dayMatches(date);
  return {
    matches,
    next(after: Date): Date | null {
      // From the minute after `after`, skipping a whole month, day or hour
      // whenever that field cannot match, so a sparse expression takes a
      // few hundred steps at most.
      let t = (Math.floor(after.getTime() / 60_000) + 1) * 60_000;
      const limit = t + 5 * 366 * 24 * 60 * 60_000;
      while (t <= limit) {
        const d = new Date(t);
        if (!months.has(d.getUTCMonth() + 1)) {
          t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
        } else if (!dayMatches(d)) {
          t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
        } else if (!hours.has(d.getUTCHours())) {
          t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
        } else if (!minutes.has(d.getUTCMinutes())) {
          t += 60_000;
        } else {
          return d;
        }
      }
      return null;
    },
  };
}

/** Whether any of `sources` falls on `date`'s minute; unreadable ones never do. */
export function ciCronDue(sources: readonly string[], date: Date): boolean {
  return sources.some((s) => {
    try {
      return parseCiCron(s).matches(date);
    } catch {
      return false;
    }
  });
}

/** The soonest minute after `after` that any of `sources` fires on, or `null`. */
export function nextCiCronDue(sources: readonly string[], after: Date): Date | null {
  let soonest: Date | null = null;
  for (const s of sources) {
    let next: Date | null;
    try {
      next = parseCiCron(s).next(after);
    } catch {
      continue;
    }
    if (next && (!soonest || next < soonest)) soonest = next;
  }
  return soonest;
}
