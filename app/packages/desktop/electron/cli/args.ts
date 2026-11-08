// The day and duration grammars behind `--last`, `--window` and friends,
// shared by `effect/range-flags.ts` (which turns them into typed `Flag`s with
// these sentences as parse errors) and any helper that reads a span. The
// command line itself is parsed by `effect/cli` (`effect/root.ts`).
import { CliError } from "./context";

/**
 * `--last 30d|12w|3m` for the day-granularity commands (costs, anomalies,
 * changes). Separate from `parseDuration` because those spans are whole days
 * and accept months, which minutes/hours never do.
 */
export function parseLastDays(text: string): number {
  const match = /^(\d+)([dwm])$/.exec(text);
  if (!match) {
    throw new CliError(`Invalid --last "${text}": use forms like 7d, 30d, 12w, 3m`, 2);
  }
  const n = Number(match[1]);
  return n * { d: 1, w: 7, m: 30 }[match[2] as "d" | "w" | "m"]!;
}

const DURATION_RE = /^(\d+)([mhdw])$/;

/** Parse `--last 90m|6h|7d|2w` into milliseconds. */
export function parseDuration(text: string): number {
  const match = DURATION_RE.exec(text);
  if (!match) {
    throw new CliError(`Invalid duration "${text}": use forms like 30m, 6h, 7d, 2w`, 2);
  }
  const n = Number(match[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }[match[2]!]!;
  return n * unit;
}
