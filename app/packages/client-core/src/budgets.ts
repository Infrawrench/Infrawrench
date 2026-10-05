/**
 * Budget shapes beyond "a monthly amount of money": what a budget measures
 * (money or a usage quantity), which periods it covers (the calendar month, a
 * custom cadence, or an explicit list of periods each with its own amount), and
 * where it sits in a hierarchy (a parent rolls up its children).
 *
 * Pure and dependency-free on purpose. The server resolves a budget's current
 * period with {@link resolveBudgetPeriod} when it evaluates thresholds, and
 * every client calls the same function to describe the period it is showing,
 * so "which days does this budget count" is answered in exactly one place.
 * `budgetInputError` is the cross-field half of validation (the zod schema in
 * `@infrawrench/ui/cost/config` checks shapes; this checks combinations), run
 * by the route, the MCP tools and every editor.
 */

import type { BudgetInput, BudgetWithStatus } from "./costs";

/** What a budget counts: money (`cost`, the default) or a usage quantity. */
export const BUDGET_MEASURES = ["cost", "usage"] as const;
export type BudgetMeasure = (typeof BUDGET_MEASURES)[number];

export const BUDGET_MEASURE_LABELS: Record<BudgetMeasure, string> = {
  cost: "Spend",
  usage: "Usage",
};

/** The units a recurring budget period can repeat in. */
export const BUDGET_PERIOD_UNITS = ["day", "week", "month", "quarter", "year"] as const;
export type BudgetPeriodUnit = (typeof BUDGET_PERIOD_UNITS)[number];

export const BUDGET_PERIOD_UNIT_LABELS: Record<BudgetPeriodUnit, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
};

/**
 * A custom cadence: periods of `interval` × `unit`, the first starting on
 * `startDate` (inclusive, UTC) and each one starting where the last ended. The
 * budget amount applies to every period.
 */
export interface BudgetRecurringPeriod {
  kind: "recurring";
  unit: BudgetPeriodUnit;
  interval: number;
  /** `YYYY-MM-DD`. Days before it belong to no period. */
  startDate: string;
}

/**
 * One entry of an explicit period list. Carries its own amount, in the budget's
 * unit: `amountCents` for a spend budget, `usageAmount` for a usage budget.
 */
export interface BudgetExplicitPeriod {
  /** `YYYY-MM-DD`, inclusive. */
  start: string;
  /** `YYYY-MM-DD`, inclusive. */
  end: string;
  amountCents?: number | undefined;
  usageAmount?: number | undefined;
}

/** A hand-written list of periods, each with its own amount. */
export interface BudgetExplicitPeriods {
  kind: "explicit";
  periods: BudgetExplicitPeriod[];
}

/**
 * Absent (null) is the calendar month, which is what every budget measured
 * before periods were configurable and still the default.
 */
export type BudgetPeriod = BudgetRecurringPeriod | BudgetExplicitPeriods;

export const BUDGET_LIMITS = {
  /** Upper bound on a recurring period's interval count. */
  maxInterval: 365,
  /** Upper bound on the entries of an explicit period list. */
  maxExplicitPeriods: 60,
  /**
   * Deepest a hierarchy may go, counting the root as level 1. Every level is a
   * second figure to explain on a page that is already a tree, and the rollup
   * re-measures each leaf over its ancestors' periods.
   */
  maxDepth: 4,
  maxUsageUnitLength: 64,
  /** Ceiling on a usage amount: a quadrillion tokens is a typo, not a budget. */
  maxUsageAmount: 1e15,
} as const;

/** One resolved period: the window a budget is currently being measured over. */
export interface BudgetPeriodWindow {
  /** `YYYY-MM-DD`, inclusive. */
  start: string;
  /** `YYYY-MM-DD`, inclusive. */
  end: string;
  /**
   * Stable identity of the period, used to fire each threshold once per period.
   * `YYYY-MM` for the calendar month (so budgets that predate periods keep the
   * alert history they already have), the start day for everything else.
   */
  key: string;
  /** The explicit entry's own amount, when the period came from a list. */
  amountCents?: number | undefined;
  usageAmount?: number | undefined;
}

/* ------------------------------------------------------------------ *
 * Date arithmetic (UTC days as YYYY-MM-DD strings).
 * ------------------------------------------------------------------ */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day in `YYYY-MM-DD` form (rejects `2026-02-30`). */
export function isBudgetDay(day: string): boolean {
  if (!ISO_DAY.test(day)) return false;
  const d = new Date(`${day}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

function toDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addBudgetDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return toDay(d);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function budgetDaysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * `anchor` plus `months`, clamped to the end of the target month. Always
 * computed from the original anchor, never chained, so a period series starting
 * on the 31st lands on the 31st whenever the month has one rather than drifting
 * to the 28th after February.
 */
function addMonthsClamped(anchor: string, months: number): string {
  const [y, m, d] = anchor.split("-").map(Number) as [number, number, number];
  const targetMonthIndex = m - 1 + months;
  const lastDay = new Date(Date.UTC(y, targetMonthIndex + 1, 0)).getUTCDate();
  return toDay(new Date(Date.UTC(y, targetMonthIndex, Math.min(d, lastDay))));
}

function monthsPerUnit(unit: BudgetPeriodUnit): number {
  return unit === "month" ? 1 : unit === "quarter" ? 3 : 12;
}

/** Start of the `k`-th period of a recurring cadence (k = 0 is `startDate`). */
function recurringStart(period: BudgetRecurringPeriod, k: number): string {
  switch (period.unit) {
    case "day":
      return addBudgetDays(period.startDate, k * period.interval);
    case "week":
      return addBudgetDays(period.startDate, k * period.interval * 7);
    default:
      return addMonthsClamped(period.startDate, k * period.interval * monthsPerUnit(period.unit));
  }
}

/** The period index containing `today` (may be negative before the start). */
function recurringIndex(period: BudgetRecurringPeriod, today: string): number {
  let k: number;
  if (period.unit === "day" || period.unit === "week") {
    const len = period.interval * (period.unit === "week" ? 7 : 1);
    k = Math.floor(budgetDaysBetween(period.startDate, today) / len);
  } else {
    const [sy, sm] = period.startDate.split("-").map(Number) as [number, number];
    const [ty, tm] = today.split("-").map(Number) as [number, number];
    const step = period.interval * monthsPerUnit(period.unit);
    k = Math.floor(((ty - sy) * 12 + (tm - sm)) / step);
    // The month arithmetic ignores the day of month, so step back when the
    // estimated period has not started yet (today is the 3rd, periods start
    // on the 15th) and forward when the next one already has.
    while (k > 0 && recurringStart(period, k) > today) k -= 1;
    while (recurringStart(period, k + 1) <= today) k += 1;
  }
  return k;
}

function recurringWindow(period: BudgetRecurringPeriod, k: number): BudgetPeriodWindow {
  const start = recurringStart(period, k);
  const end = addBudgetDays(recurringStart(period, k + 1), -1);
  return { start, end, key: start };
}

function calendarMonthWindow(today: string): BudgetPeriodWindow {
  const month = today.slice(0, 7);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const end = toDay(new Date(Date.UTC(y, m, 0)));
  return { start: `${month}-01`, end, key: month };
}

/**
 * The period of `period` containing `today`, or null when no period does (a
 * cadence that has not started yet, or a gap in an explicit list). Null in,
 * calendar month out.
 */
export function resolveBudgetPeriod(
  period: BudgetPeriod | null | undefined,
  today: string,
): BudgetPeriodWindow | null {
  if (!period) return calendarMonthWindow(today);
  if (period.kind === "explicit") {
    const entry = period.periods.find((p) => p.start <= today && today <= p.end);
    if (!entry) return null;
    return {
      start: entry.start,
      end: entry.end,
      key: entry.start,
      ...(entry.amountCents !== undefined ? { amountCents: entry.amountCents } : {}),
      ...(entry.usageAmount !== undefined ? { usageAmount: entry.usageAmount } : {}),
    };
  }
  if (today < period.startDate) return null;
  return recurringWindow(period, recurringIndex(period, today));
}

/**
 * The next period to start after `today`, for "no active period" copy. Null
 * for the calendar month (there is always a current one) and once an explicit
 * list has run out.
 */
export function upcomingBudgetPeriod(
  period: BudgetPeriod | null | undefined,
  today: string,
): BudgetPeriodWindow | null {
  if (!period) return null;
  if (period.kind === "explicit") {
    const next = [...period.periods]
      .sort((a, b) => (a.start < b.start ? -1 : 1))
      .find((p) => p.start > today);
    return next ? { start: next.start, end: next.end, key: next.start } : null;
  }
  if (today < period.startDate) return recurringWindow(period, 0);
  return recurringWindow(period, recurringIndex(period, today) + 1);
}

/**
 * A budget's limit for one resolved period, in the budget's own unit: cents of
 * its currency for a spend budget, the raw quantity for a usage budget. Null
 * when the budget defines no positive amount for that period.
 */
export function budgetLimitForWindow(
  budget: {
    measure?: BudgetMeasure | null | undefined;
    amountCents: number;
    usageAmount?: number | null | undefined;
  },
  window: BudgetPeriodWindow,
): number | null {
  const usage = budget.measure === "usage";
  const value = usage
    ? (window.usageAmount ?? budget.usageAmount ?? null)
    : (window.amountCents ?? budget.amountCents);
  return value !== null && value > 0 ? value : null;
}

/** Two period configurations describe the same series of windows. */
export function budgetPeriodsEqual(
  a: BudgetPeriod | null | undefined,
  b: BudgetPeriod | null | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/* ------------------------------------------------------------------ *
 * Validation: the combinations a schema cannot express.
 * ------------------------------------------------------------------ */

/**
 * Why `input` is not a valid budget, or null. Shape checks (types, lengths,
 * ranges) are the zod schema's; this owns the rules that span fields, so the
 * API, the MCP tools and every editor reject the same things with the same
 * sentence.
 */
export function budgetInputError(input: BudgetInput): string | null {
  const usage = input.measure === "usage";
  const explicit = input.period?.kind === "explicit";

  if (usage) {
    if (!input.usageUnit || input.usageUnit.trim().length === 0) {
      return "A usage budget needs a usage unit (for example tokens or GB).";
    }
    if (input.scenarioModelId) {
      return "Scenario models adjust spend, so they cannot apply to a usage budget.";
    }
    if (input.useAdjustedSpend) {
      return "Billing rules adjust spend, so they cannot apply to a usage budget.";
    }
    if (!explicit && !(typeof input.usageAmount === "number" && input.usageAmount > 0)) {
      return "Enter a usage amount greater than zero.";
    }
  } else {
    if (input.usageUnit || input.usageAmount !== undefined) {
      return "Usage unit and usage amount only apply to a usage budget.";
    }
    if (!explicit && !(input.amountCents > 0)) {
      return "Enter a budget amount greater than zero.";
    }
  }

  const period = input.period;
  if (period?.kind === "recurring") {
    if (!isBudgetDay(period.startDate)) return "The period start date is not a valid date.";
  } else if (period?.kind === "explicit") {
    const sorted = [...period.periods].sort((a, b) => (a.start < b.start ? -1 : 1));
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i]!;
      if (!isBudgetDay(p.start) || !isBudgetDay(p.end)) {
        return "Every period needs a valid start and end date.";
      }
      if (p.end < p.start) return `The period starting ${p.start} ends before it starts.`;
      const prev = sorted[i - 1];
      if (prev && p.start <= prev.end) {
        return `The periods starting ${prev.start} and ${p.start} overlap.`;
      }
      if (usage) {
        if (!(typeof p.usageAmount === "number" && p.usageAmount > 0)) {
          return `The period starting ${p.start} needs a usage amount greater than zero.`;
        }
        if (p.amountCents !== undefined) {
          return "Periods of a usage budget take a usage amount, not a money amount.";
        }
      } else {
        if (!(typeof p.amountCents === "number" && p.amountCents > 0)) {
          return `The period starting ${p.start} needs an amount greater than zero.`;
        }
        if (p.usageAmount !== undefined) {
          return "Periods of a spend budget take a money amount, not a usage amount.";
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Hierarchy.
 * ------------------------------------------------------------------ */

/** A budget and its child budgets, for the expandable tree. */
export interface BudgetTreeNode<B extends BudgetLike = BudgetWithStatus> {
  budget: B;
  depth: number;
  children: BudgetTreeNode<B>[];
}

interface BudgetLike {
  id: string;
  name: string;
  parentBudgetId?: string | null | undefined;
}

/**
 * Arrange a flat budget list into trees, preserving the input order among
 * siblings. A budget whose parent is not in the list (deleted, or filtered
 * out) becomes a root rather than vanishing, and a cycle (which the server
 * refuses, but a list is data) is broken at the first repeat.
 */
export function buildBudgetTree<B extends BudgetLike>(budgets: B[]): BudgetTreeNode<B>[] {
  const byId = new Map(budgets.map((b) => [b.id, b]));
  const childrenOf = new Map<string, B[]>();
  const roots: B[] = [];
  for (const b of budgets) {
    const parent = b.parentBudgetId ? byId.get(b.parentBudgetId) : undefined;
    if (parent && parent.id !== b.id) {
      const list = childrenOf.get(parent.id) ?? [];
      list.push(b);
      childrenOf.set(parent.id, list);
    } else {
      roots.push(b);
    }
  }
  const seen = new Set<string>();
  const build = (b: B, depth: number): BudgetTreeNode<B> => {
    seen.add(b.id);
    const children = (childrenOf.get(b.id) ?? [])
      .filter((c) => !seen.has(c.id))
      .map((c) => build(c, depth + 1));
    return { budget: b, depth, children };
  };
  const trees = roots.map((b) => build(b, 0));
  // Anything still unseen sits on a cycle with no root: surface it as a root.
  for (const b of budgets) if (!seen.has(b.id)) trees.push(build(b, 0));
  return trees;
}

/**
 * Ids of every budget below `id`. An editor uses it to keep a budget's own
 * descendants out of its parent picker, since choosing one would be a cycle.
 */
export function budgetDescendantIds(budgets: BudgetLike[], id: string): Set<string> {
  const out = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const b of budgets) {
      if (b.parentBudgetId === current && !out.has(b.id) && b.id !== id) {
        out.add(b.id);
        queue.push(b.id);
      }
    }
  }
  return out;
}

/** 1 for a root, 2 for its child, and so on. */
export function budgetDepth(budgets: BudgetLike[], id: string): number {
  const byId = new Map(budgets.map((b) => [b.id, b]));
  let depth = 1;
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current?.parentBudgetId && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.parentBudgetId);
    if (!current) break;
    depth += 1;
  }
  return depth;
}

/** Levels below `id`, counting `id` itself as 1. */
export function budgetSubtreeHeight(budgets: BudgetLike[], id: string): number {
  const children = budgets.filter((b) => b.parentBudgetId === id && b.id !== id);
  const seen = new Set<string>([id]);
  let height = 1;
  for (const c of children) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    height = Math.max(height, 1 + budgetSubtreeHeight(budgets, c.id));
  }
  return height;
}

/** What crossed when a parent's children outgrow it. */
export const BUDGET_HIERARCHY_WARNING_KINDS = ["allocation", "actual", "forecast"] as const;
export type BudgetHierarchyWarningKind = (typeof BUDGET_HIERARCHY_WARNING_KINDS)[number];

/**
 * A parent budget whose children outgrow it, in the parent's unit:
 *
 * - `allocation`: the children's own amounts for this period add up to more
 *   than the parent's (only children on the same period as the parent are
 *   comparable, so only they are counted);
 * - `actual`: the children have together already spent more than the parent;
 * - `forecast`: the children are together projected to.
 */
export interface BudgetHierarchyWarning {
  kind: BudgetHierarchyWarningKind;
  childTotal: number;
  parentLimit: number;
}

/* ------------------------------------------------------------------ *
 * Reading a status row the same way on every surface.
 * ------------------------------------------------------------------ */

/**
 * The figures a budget card draws, in the budget's own unit (major currency
 * units for money, the raw quantity for usage). Every card (web, desktop,
 * mobile) reads through this so the usage/money split and the period limit are
 * decided once.
 */
export interface BudgetProgress {
  measure: BudgetMeasure;
  limit: number | null;
  actual: number;
  /** The forecast the thresholds are judged on (scenario-adjusted if opted in). */
  forecast: number | null;
  /** The bare trend, set only when it differs from `forecast` (a scenario applies). */
  trendForecast: number | null;
  actualPercent: number;
  forecastPercent: number | null;
  /** False when the budget's periods do not cover today. */
  active: boolean;
}

export function budgetProgress(budget: BudgetWithStatus): BudgetProgress {
  const measure: BudgetMeasure = budget.measure === "usage" ? "usage" : "cost";
  const active = budget.periodStart !== null;
  if (measure === "usage") {
    const limit = budget.periodLimit ?? budget.usageAmount ?? null;
    const actual = budget.actualUsage ?? 0;
    const forecast = budget.forecastUsage ?? null;
    return {
      measure,
      limit: active ? limit : null,
      actual,
      forecast,
      trendForecast: null,
      actualPercent: limit && limit > 0 ? (actual / limit) * 100 : 0,
      forecastPercent: forecast !== null && limit && limit > 0 ? (forecast / limit) * 100 : null,
      active,
    };
  }
  // A server a release behind sends no `periodLimit`: the configured monthly
  // amount is what it was measuring against.
  const limitCents =
    budget.periodLimit !== undefined ? budget.periodLimit : budget.amountCents || null;
  const limit = limitCents === null ? null : limitCents / 100;
  const actual = budget.actualCents / 100;
  const judged = budget.scenarioForecastCents ?? budget.forecastCents;
  const forecast = judged === null ? null : judged / 100;
  const trendForecast =
    budget.scenarioForecastCents != null && budget.forecastCents !== null
      ? budget.forecastCents / 100
      : null;
  return {
    measure,
    limit,
    actual,
    forecast,
    trendForecast,
    actualPercent: limit && limit > 0 ? (actual / limit) * 100 : 0,
    forecastPercent: forecast !== null && limit && limit > 0 ? (forecast / limit) * 100 : null,
    active,
  };
}

/** A usage quantity with its unit, compact: "1.25M tokens", "380 GB". */
export function formatUsageQuantity(value: number, unit: string | null | undefined): string {
  let text: string;
  try {
    text = new Intl.NumberFormat(undefined, {
      notation: Math.abs(value) >= 10_000 ? "compact" : "standard",
      maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1,
    }).format(value);
  } catch {
    text = String(Math.round(value * 100) / 100);
  }
  return unit ? `${text} ${unit}` : text;
}

/** A period window as "Oct 1 – Oct 31, 2026" (or a single day). */
export function formatBudgetPeriodWindow(window: { start: string; end: string }): string {
  const fmt = (day: string, withYear: boolean) => {
    const d = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return day;
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  };
  if (window.start === window.end) return fmt(window.start, true);
  const sameYear = window.start.slice(0, 4) === window.end.slice(0, 4);
  return `${fmt(window.start, !sameYear)} – ${fmt(window.end, true)}`;
}

/**
 * The editable input for an existing budget. Every field round-trips, so
 * saving a rename from any host never silently resets a setting that host's
 * editor does not show (the adjusted-spend opt-in, a parent, a period list).
 */
export function budgetWithStatusToInput(budget: BudgetWithStatus): BudgetInput {
  return {
    name: budget.name,
    amountCents: budget.amountCents,
    currency: budget.currency,
    filters: budget.filters,
    thresholds: budget.thresholds,
    ...(budget.costBasis ? { costBasis: budget.costBasis } : {}),
    ...(budget.savedFilterId ? { savedFilterId: budget.savedFilterId } : {}),
    ...(budget.scenarioModelId ? { scenarioModelId: budget.scenarioModelId } : {}),
    ...(budget.useAdjustedSpend ? { useAdjustedSpend: budget.useAdjustedSpend } : {}),
    ...(budget.measure === "usage" ? { measure: "usage" as const } : {}),
    ...(budget.usageUnit ? { usageUnit: budget.usageUnit } : {}),
    ...(budget.usageAmount != null ? { usageAmount: budget.usageAmount } : {}),
    ...(budget.period ? { period: budget.period } : {}),
    ...(budget.parentBudgetId ? { parentBudgetId: budget.parentBudgetId } : {}),
    // Carried so the editor shows (and can change) who this budget emails.
    ...(budget.emailRecipients ? { emailRecipients: budget.emailRecipients } : {}),
  };
}
