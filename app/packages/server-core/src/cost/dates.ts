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
  const a = new Date(`${from}T00:00:00.000Z`).getTime();
  const b = new Date(`${to}T00:00:00.000Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
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
