/**
 * Change-based cost alert arithmetic — **pure**. No db, no ClickHouse, no
 * clock of its own (callers pass "today"), which is what makes the window
 * definitions and threshold rules exhaustively testable.
 *
 * This is the third cost-alert family and deliberately not the other two:
 *
 * - **Budgets** (`budget-eval.ts`) fire on an *absolute monthly total* the
 *   user chose.
 * - **Anomalies** (`anomaly-detect.ts`) fire on unconfigured *statistical
 *   outliers* against a learned baseline.
 * - **Change alerts** (this module + `change-eval.ts`) fire on a *configured
 *   relative change*: "spend on this scope moved more than X% (or $Y) versus
 *   the prior period", on a scope, cadence and direction the user chose.
 *
 * ## Windows, exactly
 *
 * All windows are inclusive complete UTC days. The current (accruing) day is
 * never part of any window — a partial day always reads as a dip.
 *
 * - `daily` — one complete day `D` vs **the same weekday one week earlier**
 *   (`D-7`). Not `D-1`: most estates have weekday seasonality, and comparing
 *   Monday to Sunday would fire every week. Each complete day inside the
 *   restatement horizon is its own window, keyed by `D`, so a day re-judged
 *   after late-arriving data uses the same key and the events-table unique
 *   index absorbs the re-fire.
 * - `weekly` — the last 7 complete days `[today-7, today-1]` vs the 7
 *   complete days before them `[today-14, today-8]`. The window slides as
 *   days complete; the period key is the ISO week of the window's *end* day,
 *   so a sustained change fires once per calendar week, not once per day.
 * - `monthly` — month-to-date, meaning the current month's complete days
 *   `[1st, today-1]`, vs **the same number of days from the start of the
 *   prior month** (clamped to that month's length: 30 March days compare to
 *   all 28 of February). Never MTD vs the *full* prior month — that classic
 *   mistake compares 9 days to 31 and reads "down 70%" until the month is
 *   nearly over. On the 1st there are no complete days yet and there is no
 *   window at all. The period key is the month, so one month fires once.
 *
 * ## Thresholds
 *
 * A percent threshold, an absolute (cents) threshold, or both. When both are
 * set **both must hold** — that is the design, not an accident: percent alone
 * pages someone about a 50% jump on $2 of spend, absolute alone pages about a
 * 0.4% wobble on a huge bill. Direction filters which sign of movement counts.
 *
 * ## Groups that appear and disappear
 *
 * - Present now, absent in the prior window: **new spend**. The percent
 *   change is infinite, not a number — `changePercent` is `null`, any percent
 *   threshold is treated as satisfied (an infinite change exceeds every
 *   percent), and the absolute threshold still applies. An alert with only a
 *   percent threshold therefore flags every new group, however small; the
 *   editor nudges users toward an absolute floor for exactly this reason.
 * - Absent now, present before: **gone** — a -100% change with
 *   `changePercent: -100`, judged like any other decrease.
 * - Absent in both: nothing happened; no finding.
 *
 * Currency is part of a group's identity here: amounts in different
 * currencies are never summed or compared against each other. `change-eval`
 * converts what it can into the org display currency *before* calling in;
 * a currency with no stated rate arrives unconverted and is compared in its
 * own currency — surfaced, never dropped.
 */
import { addDays } from "./dates";

/** How the change-eval evaluation cadences compare windows. */
export type ChangeCadence = "daily" | "weekly" | "monthly";

export type ChangeDirection = "increase" | "decrease" | "both";

/** An inclusive UTC day span. */
export interface DaySpan {
  from: string;
  to: string;
}

/** One comparison to run: the current window, its prior window, and the dedup key. */
export interface ChangeWindow {
  current: DaySpan;
  previous: DaySpan;
  /**
   * The cadence period this window belongs to — the events-table dedup key.
   * The day for `daily`, `YYYY-Www` for `weekly`, `YYYY-MM` for `monthly`.
   */
  periodKey: string;
}

/**
 * How many trailing complete days a `daily` alert re-examines per pass.
 * Matches the anomaly evaluator's window and exists for the same reason:
 * providers restate a trailing window (`DEFAULT_RESTATEMENT_DAYS` in
 * `collect.ts`) and an org's accounts collect at jittered times, so a day
 * judged once, early, could miss a real change for good. Re-fires are
 * absorbed by the events-table unique index on the period key.
 */
export const CHANGE_EVALUATION_DAYS = 3;

/** First day of `day`'s UTC month. */
function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Last day of `day`'s UTC month. */
function monthEnd(day: string): string {
  const d = new Date(`${day.slice(0, 7)}-01T00:00:00.000Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

/**
 * ISO-8601 week key ("2026-W32") for a UTC day. The ISO week's year can
 * differ from the calendar year at year boundaries (Jan 1st can belong to
 * week 52/53 of the prior year), which is why the key carries the ISO year.
 */
export function isoWeekKey(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  // Shift to the Thursday of this week: ISO weeks belong to the year that
  // contains their Thursday.
  const dayOfWeek = d.getUTCDay() || 7; // 1 (Mon) … 7 (Sun)
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * The comparisons a cadence should run when evaluated on `today` (a UTC
 * `YYYY-MM-DD`). Empty when no complete window exists yet — the 1st of the
 * month for `monthly`.
 *
 * `daily` returns one window per complete day in the restatement horizon,
 * oldest first, so a day that only now looks changed fires before fresher
 * days. `weekly` and `monthly` return one window each; their spans include
 * the restatement horizon by construction, so later passes re-evaluate them
 * with restated data and the period key absorbs the re-fire.
 */
export function changeWindows(
  cadence: ChangeCadence,
  today: string,
  evaluationDays = CHANGE_EVALUATION_DAYS,
): ChangeWindow[] {
  switch (cadence) {
    case "daily": {
      const windows: ChangeWindow[] = [];
      for (let back = evaluationDays; back >= 1; back--) {
        const day = addDays(today, -back);
        windows.push({
          current: { from: day, to: day },
          previous: { from: addDays(day, -7), to: addDays(day, -7) },
          periodKey: day,
        });
      }
      return windows;
    }
    case "weekly": {
      const end = addDays(today, -1);
      return [
        {
          current: { from: addDays(today, -7), to: end },
          previous: { from: addDays(today, -14), to: addDays(today, -8) },
          periodKey: isoWeekKey(end),
        },
      ];
    }
    case "monthly": {
      const end = addDays(today, -1);
      const start = monthStart(today);
      // On the 1st, yesterday belongs to the prior month: there are no
      // complete days in the current month yet, so there is nothing to judge.
      if (end < start) return [];
      const days = daysInclusive(start, end);
      const prevStart = monthStart(addDays(start, -1));
      // Same number of days from the prior month's start, clamped to its
      // length — 30 days of March compare to all 28 of February.
      const prevEndUnclamped = addDays(prevStart, days - 1);
      const prevEnd =
        prevEndUnclamped < monthEnd(prevStart) ? prevEndUnclamped : monthEnd(prevStart);
      return [
        {
          current: { from: start, to: end },
          previous: { from: prevStart, to: prevEnd },
          periodKey: today.slice(0, 7),
        },
      ];
    }
  }
}

/** Whole days in an inclusive span (both ends counted). */
function daysInclusive(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00.000Z`).getTime();
  const b = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/** The minimum a series needs for windowing — matches `CostSeriesGroup`. */
export interface ChangeSeriesGroup {
  /** Group key; "" when the alert watches one ungrouped total. */
  key: string;
  currency: string;
  points: Array<{ bucket: string; amount: number }>;
}

/** One (group, currency)'s spend in each window, in currency units. */
export interface ChangeGroupTotals {
  key: string;
  currency: string;
  previousAmount: number;
  currentAmount: number;
}

/**
 * Sum each group's points inside the two windows. Groups that never touch
 * either window vanish; a group with spend in exactly one window survives
 * with a zero on the other side — that zero is what the new/vanished rules
 * in {@link detectChanges} key on. Two input groups sharing (key, currency)
 * — as `convertGroups` can produce before merging — are folded together.
 */
export function windowTotals(
  groups: ChangeSeriesGroup[],
  current: DaySpan,
  previous: DaySpan,
): ChangeGroupTotals[] {
  const byId = new Map<string, ChangeGroupTotals>();
  for (const group of groups) {
    const id = `${group.key} ${group.currency}`;
    let totals = byId.get(id);
    for (const point of group.points) {
      const inCurrent = point.bucket >= current.from && point.bucket <= current.to;
      const inPrevious = point.bucket >= previous.from && point.bucket <= previous.to;
      if (!inCurrent && !inPrevious) continue;
      if (!totals) {
        totals = { key: group.key, currency: group.currency, previousAmount: 0, currentAmount: 0 };
        byId.set(id, totals);
      }
      if (inCurrent) totals.currentAmount += point.amount;
      if (inPrevious) totals.previousAmount += point.amount;
    }
  }
  return [...byId.values()];
}

/** The thresholds an alert judges a change against. */
export interface ChangeThresholds {
  /** Percent of the prior window the change must reach, or null. */
  thresholdPercent: number | null;
  /** Cents the change must reach, or null. At least one is always set. */
  thresholdAmountCents: number | null;
  direction: ChangeDirection;
}

/** One (group, currency) whose movement cleared the thresholds. */
export interface ChangeFinding {
  groupKey: string;
  currency: string;
  /** Both windows' spend, in cents (rounded). */
  previousAmountCents: number;
  currentAmountCents: number;
  /**
   * Signed percent change, rounded. Null when the prior window had no spend
   * — the change is infinite, and every surface says "new" instead of
   * printing a made-up number. -100 when the group vanished.
   */
  changePercent: number | null;
  direction: "increase" | "decrease";
}

/**
 * Judge every (group, currency)'s movement against the thresholds.
 *
 * The rules, in order:
 * - Amounts are compared in cents. A delta that rounds to zero cents is no
 *   change at all, whatever the floats say.
 * - Direction comes from the delta's sign; an alert watching one direction
 *   ignores the other entirely.
 * - Percent change is `delta / |previous| * 100`. The absolute value keeps
 *   the sign meaningful when the prior window nets negative (a refund-heavy
 *   window): spend moving from -$50 to $100 is an increase.
 * - No prior spend at all (previous rounds to zero cents, current does not)
 *   is **new spend**: `changePercent` is null and a percent threshold is
 *   treated as satisfied — an infinite change exceeds any percent. The
 *   absolute threshold still applies, which is what keeps a $0.30 new group
 *   from paging anyone whose alert carries a floor.
 * - When both thresholds are set, both must hold.
 */
export function detectChanges(
  totals: ChangeGroupTotals[],
  thresholds: ChangeThresholds,
): ChangeFinding[] {
  const findings: ChangeFinding[] = [];
  for (const t of totals) {
    const previousCents = Math.round(t.previousAmount * 100);
    const currentCents = Math.round(t.currentAmount * 100);
    const deltaCents = currentCents - previousCents;
    if (deltaCents === 0) continue;

    const direction: "increase" | "decrease" = deltaCents > 0 ? "increase" : "decrease";
    if (thresholds.direction !== "both" && thresholds.direction !== direction) continue;

    // Percent against the prior window; null when there was no prior spend.
    const changePercent =
      previousCents === 0 ? null : Math.round((deltaCents / Math.abs(previousCents)) * 100);

    const percentOk =
      thresholds.thresholdPercent === null ||
      changePercent === null || // new spend: an infinite change clears any percent bar
      Math.abs(changePercent) >= thresholds.thresholdPercent;
    const amountOk =
      thresholds.thresholdAmountCents === null ||
      Math.abs(deltaCents) >= thresholds.thresholdAmountCents;
    if (!percentOk || !amountOk) continue;

    findings.push({
      groupKey: t.key,
      currency: t.currency,
      previousAmountCents: previousCents,
      currentAmountCents: currentCents,
      changePercent,
      direction,
    });
  }
  return findings;
}
