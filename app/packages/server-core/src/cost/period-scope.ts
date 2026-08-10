/**
 * Which days a collection restated — the input to superseded-row
 * reconciliation's second guard.
 *
 * Pure, day-string arithmetic only. No clock, no table, no ClickHouse.
 *
 * ─── Why a day is not always the unit ─────────────────────────────────────
 *
 * `clickhouse/cost-reconcile.ts` zeroes a stored key the collection did not
 * rewrite, but only on days the collection wrote at least one row to. That
 * guard is what stops a provider that reports the last 24 hours late from
 * wiping yesterday, and for a plugin whose rows *are* daily it is exactly
 * right.
 *
 * It is not right for a **period-native** plugin. Those report an invoice or a
 * billing-cycle total and date the whole thing to one day of the period, so a
 * month of spend touches exactly one day and the other thirty are, from the
 * plugin's point of view, days it has nothing to say about — not days it
 * skipped. Guard 2 reads them as skipped, and anything stored inside the
 * period survives untouched forever.
 *
 * That is not hypothetical. Mistral's collector used to date an in-progress
 * month's running total to the month end *clamped into the requested range*,
 * so the 15th held month-to-date-through-15, the 16th held month-to-date-
 * through-16, and the month summed to the sum of its own prefixes — roughly
 * 15× the real figure by mid-month. Dating the row to the period start fixes
 * the accumulation going forward (one key, replaced on every collection), but
 * the rows already written on days 2..N are stranded: nothing rewrites those
 * days, so reconciliation never considered them.
 *
 * ─── The rule ─────────────────────────────────────────────────────────────
 *
 * For a period-native plugin, a written row dated to the **first of a calendar
 * month** restates that whole month. Everything else keeps the day rule.
 *
 * Read as a claim: "this collection has just written the total for this
 * calendar month, so any *other* key stored inside the month that it did not
 * write is intra-period residue". That is true of a month-native plugin by
 * construction — its period total lives on one day and the interior holds
 * nothing else — and it repairs the stranded prefixes on the next collection
 * that covers the month, with no operator step and no plugin-specific code.
 *
 * The restriction to the 1st is deliberate rather than incidental. Not every
 * period-native plugin bills on calendar months: Cloudflare's charge periods
 * follow each subscription's billing-cycle anchor, Turso dates rows to an
 * invoice due date, OVH to a bill's issue date. Several of those can hold
 * legitimate rows on several days of one month, and widening the unit to
 * "whatever month a written row happens to fall in" would let one flaky page
 * of a provider's invoice list zero a sibling invoice. A row on the 1st is the
 * signal that the *calendar month* is the period being restated, and no
 * plugin writes a calendar-month total to the 1st without meaning it.
 *
 * The chunk range bounds everything anyway: reconciliation only ever reads
 * back keys inside the range it just collected, so a month is only reachable
 * to the extent the collection covered it.
 */

/** `YYYY-MM-DD` → `YYYY-MM`. Callers pass day strings, never Dates. */
function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** True for `YYYY-MM-01` — the only day that stands in for a calendar month. */
function isMonthStart(day: string): boolean {
  return /^\d{4}-\d{2}-01$/.test(day);
}

/**
 * The set of days a collection restated, as a membership test.
 *
 * `periodNative` comes from the plugin's own cost capability declaration, so a
 * plugin that reports true daily spend is unaffected by any of this.
 */
export interface RestatedDayScope {
  has(day: string): boolean;
}

export function restatedDayScope(
  writtenDays: Iterable<string>,
  options?: { periodNative?: boolean | undefined },
): RestatedDayScope {
  const days = new Set<string>();
  const months = new Set<string>();
  const periodNative = options?.periodNative === true;

  for (const day of writtenDays) {
    days.add(day);
    if (periodNative && isMonthStart(day)) months.add(monthOf(day));
  }

  return {
    has: (day: string) => days.has(day) || months.has(monthOf(day)),
  };
}
