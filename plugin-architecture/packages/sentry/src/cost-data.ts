/**
 * Cost collection for Sentry, from the organization usage stats endpoint
 * (`GET /organizations/{org}/stats_v2/`, verified against
 * https://docs.sentry.io/api/organizations/retrieve-event-counts-for-an-organization-v2/
 * and the endpoint's source, 2026-10):
 *
 * - `field=sum(quantity)` is an event count for most categories, bytes for
 *   attachments and logs (`log_byte`), and milliseconds for profiling.
 * - `interval` is between `1h` and `1d`; ranges reach back at most 90 days.
 * - `groupBy=project` returns totals over the whole requested range, never a
 *   time series, which is why the per-project breakdown is one request per day.
 *
 * Sentry's API has no spend, budget or invoice data and no prices, so amounts
 * are usage beyond each category's monthly included volume times the rates in
 * `rates.ts`, and the manifest declares `estimated`.
 *
 * **Month-to-date differencing**, as for other usage-priced plugins: a
 * category is free until the month's accepted volume passes its included
 * amount, so each day's billable volume is the month-to-date volume above the
 * allowance at the end of the day minus the same at the end of the day before.
 * A month's rows therefore sum to what the month bills at the configured
 * rates. That needs each month read from its 1st, so collection reads the
 * whole month's daily series and only writes the days inside the range.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { SentryContext } from "./api.js";
import { isPermissionError, sentryFetch } from "./api.js";
import type { SentryRates, UsageCategory } from "./rates.js";
import { SERVICES, USAGE_CATEGORIES, usageCategoryOf } from "./rates.js";

const DAY_MS = 86_400_000;
/** stats_v2 answers at most 90 days back. */
export const MAX_STATS_DAYS = 90;

export interface StatsGroup {
  by: Record<string, string | number>;
  totals: Record<string, number>;
  series?: Record<string, number[]>;
}

export interface StatsResponse {
  start?: string;
  end?: string;
  intervals?: string[];
  groups?: StatsGroup[];
}

export interface StatsQuery {
  groupBy: string[];
  start: string;
  end: string;
  interval?: string;
  outcome?: string[];
  category?: string[];
  project?: Array<string | number>;
}

/** One stats_v2 call. Dates are ISO timestamps; `end` is inclusive. */
export function fetchStats(ctx: SentryContext, org: string, q: StatsQuery): Promise<StatsResponse> {
  return sentryFetch<StatsResponse>(ctx, `/organizations/${encodeURIComponent(org)}/stats_v2/`, {
    query: {
      field: "sum(quantity)",
      groupBy: q.groupBy,
      start: q.start,
      end: q.end,
      interval: q.interval ?? "1d",
      ...(q.outcome ? { outcome: q.outcome } : {}),
      ...(q.category ? { category: q.category } : {}),
      project: q.project ?? ["-1"],
    },
  });
}

const QTY = "sum(quantity)";

export const dayStart = (date: string) => `${date}T00:00:00Z`;
export const dayEnd = (date: string) => `${date}T23:59:59Z`;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Month {
  /** `YYYY-MM-01`. */
  start: string;
  /** First day of the next month. */
  end: string;
}

/** Calendar months (UTC) that overlap `[from, to]`. */
export function monthsCovering(from: string, to: string): Month[] {
  const out: Month[] = [];
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    out.push({
      start: `${y}-${String(m).padStart(2, "0")}-01`,
      end: `${ny}-${String(nm).padStart(2, "0")}-01`,
    });
    y = ny;
    m = nm;
  }
  return out;
}

/** Days `[from, to]` inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(dayStart(from)); t <= Date.parse(dayStart(to)); t += DAY_MS) {
    out.push(isoDate(t));
  }
  return out;
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Daily accepted volume per priced category (in priced units) from a
 * `groupBy=category` series, keyed by date then category key.
 */
export function dailyByCategory(res: StatsResponse): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  const intervals = res.intervals ?? [];
  for (const g of res.groups ?? []) {
    const cat = usageCategoryOf(String(g.by["category"] ?? ""));
    if (!cat) continue;
    const series = g.series?.[QTY] ?? [];
    series.forEach((value, i) => {
      const at = intervals[i];
      if (!at || !value) return;
      const date = at.slice(0, 10);
      let day = out.get(date);
      if (!day) out.set(date, (day = new Map()));
      day.set(cat.key, (day.get(cat.key) ?? 0) + value / cat.divisor);
    });
  }
  return out;
}

/**
 * Billable volume per day for one category: the month-to-date total above
 * the included amount at the end of the day, minus the same the day before.
 */
export function billableByDay(
  days: string[],
  daily: Map<string, Map<string, number>>,
  key: string,
  included: number,
): Map<string, number> {
  const out = new Map<string, number>();
  let cumulative = 0;
  for (const day of days) {
    const before = Math.max(0, cumulative - included);
    cumulative += daily.get(day)?.get(key) ?? 0;
    out.set(day, Math.max(0, cumulative - included) - before);
  }
  return out;
}

/** Per-project accepted volume (priced units) per category key, from a `groupBy=[category,project]` call. */
export function projectTotals(res: StatsResponse): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const g of res.groups ?? []) {
    const cat = usageCategoryOf(String(g.by["category"] ?? ""));
    if (!cat) continue;
    const project = String(g.by["project"] ?? "");
    const qty = (g.totals[QTY] ?? 0) / cat.divisor;
    if (!qty) continue;
    let byCat = out.get(cat.key);
    if (!byCat) out.set(cat.key, (byCat = new Map()));
    byCat.set(project, (byCat.get(project) ?? 0) + qty);
  }
  return out;
}

export interface MonitorCounts {
  cron: number;
  uptime: number;
}

export interface CostInputs {
  org: string;
  rates: SentryRates;
  /** Project id -> slug, for the `project` tag. */
  projectSlugs: Map<string, string>;
  /** Active (not paused) monitors right now, priced for the current month. */
  monitors?: () => Promise<MonitorCounts>;
}

function categoryRows(
  ctx: SentryContext,
  inputs: CostInputs,
  cat: UsageCategory,
  date: string,
  billable: number,
  byProject: Map<string, number> | undefined,
): CostRow[] {
  const price = inputs.rates[cat.key].price;
  if (price === undefined || !byProject) return [];
  const total = [...byProject.values()].reduce((a, b) => a + b, 0);
  const rows: CostRow[] = [];
  for (const [projectId, qty] of byProject) {
    if (qty <= 0) continue;
    const share = total > 0 ? qty / total : 0;
    const project = inputs.projectSlugs.get(projectId) ?? projectId;
    rows.push({
      date,
      service: cat.service,
      region: ctx.instance.id,
      tags: { project, projectId },
      currency: "USD",
      amount: round(billable * share * price),
      usageAmount: round(qty),
      usageUnit: cat.unit,
    });
  }
  return rows;
}

/**
 * Daily estimated cost rows for `range`, by category (`service`), with the
 * project as a tag; plus the plan fee and the current month's cron and uptime
 * monitors, dated to the 1st of the month they bill.
 */
export async function fetchSentryCostData(
  ctx: SentryContext,
  inputs: CostInputs,
  range: CostFetchRange,
  nowMs = Date.now(),
): Promise<CostRow[]> {
  const today = isoDate(nowMs);
  const earliest = isoDate(nowMs - (MAX_STATS_DAYS - 1) * DAY_MS);
  const rows: CostRow[] = [];
  const inRange = (d: string) => d >= range.fromDate && d <= range.toDate;
  try {
    for (const month of monthsCovering(range.fromDate, range.toDate)) {
      if (month.start > today) break;
      const monthLast = isoDate(Date.parse(dayStart(month.end)) - DAY_MS);
      const last = monthLast < today ? monthLast : today;
      const first = month.start < earliest ? earliest : month.start;
      if (first > last) continue;
      const days = daysBetween(first, last);

      if (inputs.rates.planFee > 0 && inRange(month.start)) {
        rows.push({
          date: month.start,
          service: SERVICES.plan,
          region: ctx.instance.id,
          currency: "USD",
          amount: inputs.rates.planFee,
        });
      }

      const series = await fetchStats(ctx, inputs.org, {
        groupBy: ["category"],
        outcome: ["accepted"],
        start: dayStart(first),
        end: dayEnd(last),
      });
      const daily = dailyByCategory(series);
      const billable = new Map(
        USAGE_CATEGORIES.map((c) => [
          c.key,
          billableByDay(days, daily, c.key, inputs.rates[c.key].included),
        ]),
      );
      const wanted = days.filter((d) => inRange(d) && (daily.get(d)?.size ?? 0) > 0);
      const perDay = await mapLimit(wanted, 4, (d) =>
        fetchStats(ctx, inputs.org, {
          groupBy: ["category", "project"],
          outcome: ["accepted"],
          start: dayStart(d),
          end: dayEnd(d),
        }).then((res) => [d, projectTotals(res)] as const),
      );
      for (const [date, byCat] of perDay) {
        for (const cat of USAGE_CATEGORIES) {
          rows.push(
            ...categoryRows(
              ctx,
              inputs,
              cat,
              date,
              billable.get(cat.key)?.get(date) ?? 0,
              byCat.get(cat.key),
            ),
          );
        }
      }

      // Monitors are billed per monitor per month and stats_v2 carries no
      // seat counts, so only the current month is priced, from inventory.
      if (inputs.monitors && month.start <= today && today < month.end && inRange(month.start)) {
        const counts = await inputs.monitors().catch(() => undefined);
        if (counts) {
          for (const [count, r, service] of [
            [counts.cron, inputs.rates.cronMonitors, SERVICES.cronMonitors],
            [counts.uptime, inputs.rates.uptimeMonitors, SERVICES.uptimeMonitors],
          ] as const) {
            if (count <= 0 || r.price === undefined) continue;
            rows.push({
              date: month.start,
              service,
              region: ctx.instance.id,
              currency: "USD",
              amount: round(Math.max(0, count - r.included) * r.price),
              usageAmount: count,
              usageUnit: "Monitors",
            });
          }
        }
      }
    }
  } catch (err) {
    if (isPermissionError(err)) {
      throw new CostSetupError(
        `The Sentry token cannot read usage stats for "${inputs.org}". Use an internal integration or personal token with the org:read scope.`,
        {
          label: "Sentry usage stats API",
          url: "https://docs.sentry.io/api/organizations/retrieve-event-counts-for-an-organization-v2/",
        },
      );
    }
    throw err;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Month-to-date summary for the organization detail view
// ---------------------------------------------------------------------------

export interface UsageSummary {
  month: string;
  categories: Array<{
    key: string;
    label: string;
    unit: string;
    accepted: number;
    filtered: number;
    rateLimited: number;
    billable: number;
    cost?: number;
  }>;
  monitors?: MonitorCounts;
  totalCost: number;
  byProject: Array<{ project: string; errors: number; spans: number; replays: number }>;
}

export async function fetchUsageSummary(
  ctx: SentryContext,
  inputs: CostInputs,
  nowMs = Date.now(),
): Promise<UsageSummary> {
  const today = isoDate(nowMs);
  const month = today.slice(0, 7);
  const start = dayStart(`${month}-01`);
  const end = dayEnd(today);
  const [byOutcome, byProject, monitors] = await Promise.all([
    fetchStats(ctx, inputs.org, { groupBy: ["category", "outcome"], start, end }),
    fetchStats(ctx, inputs.org, {
      groupBy: ["category", "project"],
      outcome: ["accepted"],
      start,
      end,
    }).catch(() => ({ groups: [] }) as StatsResponse),
    inputs.monitors ? inputs.monitors().catch(() => undefined) : Promise.resolve(undefined),
  ]);
  const totals = new Map<string, { accepted: number; filtered: number; rateLimited: number }>();
  for (const g of byOutcome.groups ?? []) {
    const cat = usageCategoryOf(String(g.by["category"] ?? ""));
    if (!cat) continue;
    const qty = (g.totals[QTY] ?? 0) / cat.divisor;
    const t = totals.get(cat.key) ?? { accepted: 0, filtered: 0, rateLimited: 0 };
    const outcome = String(g.by["outcome"] ?? "");
    if (outcome === "accepted") t.accepted += qty;
    else if (outcome === "filtered") t.filtered += qty;
    else if (outcome === "rate_limited") t.rateLimited += qty;
    totals.set(cat.key, t);
  }
  const summary: UsageSummary = {
    month,
    categories: [],
    totalCost: inputs.rates.planFee,
    byProject: [],
  };
  for (const cat of USAGE_CATEGORIES) {
    const t = totals.get(cat.key);
    if (!t || t.accepted + t.filtered + t.rateLimited === 0) continue;
    const r = inputs.rates[cat.key];
    const billable = Math.max(0, t.accepted - r.included);
    const cost = r.price !== undefined ? round(billable * r.price) : undefined;
    if (cost !== undefined) summary.totalCost += cost;
    summary.categories.push({
      key: cat.key,
      label: cat.service,
      unit: cat.unit.toLowerCase(),
      ...t,
      billable,
      ...(cost !== undefined ? { cost } : {}),
    });
  }
  if (monitors) {
    summary.monitors = monitors;
    for (const [count, key, label] of [
      [monitors.cron, "cronMonitors", SERVICES.cronMonitors],
      [monitors.uptime, "uptimeMonitors", SERVICES.uptimeMonitors],
    ] as const) {
      if (count <= 0) continue;
      const r = inputs.rates[key];
      const billable = Math.max(0, count - r.included);
      const cost = r.price !== undefined ? round(billable * r.price) : undefined;
      if (cost !== undefined) summary.totalCost += cost;
      summary.categories.push({
        key,
        label,
        unit: "monitors",
        accepted: count,
        filtered: 0,
        rateLimited: 0,
        billable,
        ...(cost !== undefined ? { cost } : {}),
      });
    }
  }
  summary.totalCost = round(summary.totalCost);
  const perProject = projectTotals(byProject);
  const projects = new Set<string>();
  for (const m of perProject.values()) for (const p of m.keys()) projects.add(p);
  summary.byProject = [...projects]
    .map((id) => ({
      project: inputs.projectSlugs.get(id) ?? id,
      errors: perProject.get("errors")?.get(id) ?? 0,
      spans: perProject.get("spans")?.get(id) ?? 0,
      replays: perProject.get("replays")?.get(id) ?? 0,
    }))
    .sort((a, b) => b.errors - a.errors || b.spans - a.spans)
    .slice(0, 25);
  return summary;
}
