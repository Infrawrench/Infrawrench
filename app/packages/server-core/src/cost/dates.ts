/** Pure UTC day/date-range helpers for cost collection. No side effects. */

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDay(d);
}

/**
 * Whole UTC days from `from` to `to` — negative when `to` precedes `from`,
 * and 0 for a malformed input so callers using it as a coverage measure fail
 * closed rather than treating garbage as unlimited history.
 */
export function daysBetween(from: string, to: string): number {
  const a = utcDayStart(from);
  const b = utcDayStart(to);
  if (a === null || b === null) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * `YYYY-MM-DD` → epoch ms, or null if it is not that exact shape *or* not a
 * real calendar day.
 *
 * The round-trip comparison is the point. `Date` silently rolls an out-of-range
 * day over — `2024-02-30` parses as March 1st, not as invalid — so a bare
 * NaN check would let a nonsense date through as a plausible one and make a
 * coverage measure read a day *longer* than reality, which fails open. Only a
 * string that survives parse-and-reformat unchanged is a day.
 */
function utcDayStart(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00.000Z`);
  const ms = parsed.getTime();
  if (Number.isNaN(ms) || isoDay(parsed) !== day) return null;
  return ms;
}

/**
 * Split an inclusive date range into calendar-month-aligned chunks (first
 * and last chunks may be partial). Cost APIs commonly cap request windows at
 * ~31 days (DigitalOcean insights, ClickHouse Cloud) and month-sized pages
 * keep per-request AWS Cost Explorer charges bounded during backfill.
 */
export function monthChunks(
  fromDate: string,
  toDate: string,
): Array<{ fromDate: string; toDate: string }> {
  const chunks: Array<{ fromDate: string; toDate: string }> = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    const d = new Date(`${cursor}T00:00:00.000Z`);
    const monthEnd = isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    const chunkEnd = monthEnd < toDate ? monthEnd : toDate;
    chunks.push({ fromDate: cursor, toDate: chunkEnd });
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
}
