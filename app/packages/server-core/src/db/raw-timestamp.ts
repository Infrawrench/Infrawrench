/**
 * Normalize a timestamp selected through raw `` sql`…` `` into a `Date`.
 *
 * Drizzle's column mapping never runs on a raw-SQL selection (a `max(…)`
 * aggregate, a correlated subquery), so postgres-js hands back the wire string
 * — `"2026-08-25 16:42:28.855"`, zoneless — no matter what the `sql<…>` type
 * parameter claims. Our `timestamp` columns store UTC, and drizzle's own
 * mapping reads them that way (`new Date(value + "+0000")`); a bare
 * `new Date(string)` would instead parse as server-local time and skew the
 * value by the host's UTC offset.
 *
 * Its own module (rather than living in `client.ts`) so it can be imported and
 * unit-tested without the connection side effect — `client.ts` throws at
 * import time when `DATABASE_URL` is unset.
 */
export function rawTimestampToDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  // An offset or trailing Z means the string already says its zone.
  return new Date(/[zZ]$|[+-]\d\d(:?\d\d)?$/.test(value) ? value : value + "+0000");
}
