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
