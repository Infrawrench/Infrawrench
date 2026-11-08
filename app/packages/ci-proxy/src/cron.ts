// Matches cron expressions on the minute, in UTC. The runner's parser
// (`iwci-spec/src/cron.rs`) is the one that validates a pipeline's
// expressions; this matcher only reads expressions a runner already
// accepted, and follows the same rules: five fields with `*`, numbers,
// ranges, steps and lists, month and weekday names, Sunday as 0 or 7, the
// `@hourly` family, and day-of-month OR day-of-week when both are set.
// `src/__tests__/cron.test.ts` holds the same cases as the Rust tests.

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

export interface Cron {
  matches(date: Date): boolean;
}

export function parseCron(source: string): Cron {
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
  return {
    matches(date: Date): boolean {
      if (!minutes.has(date.getUTCMinutes()) || !hours.has(date.getUTCHours())) return false;
      if (!months.has(date.getUTCMonth() + 1)) return false;
      const day = days.has(date.getUTCDate());
      const weekday = weekdays.has(date.getUTCDay());
      if (anyDay && anyWeekday) return true;
      if (anyWeekday) return day;
      if (anyDay) return weekday;
      return day || weekday;
    },
  };
}

/** Whether any of `sources` falls on `date`'s minute; unreadable ones never do. */
export function anyDue(sources: string[], date: Date): boolean {
  return sources.some((s) => {
    try {
      return parseCron(s).matches(date);
    } catch {
      return false;
    }
  });
}
