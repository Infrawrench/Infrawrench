/**
 * Daily data usage, normalised to one cell per day, pillar and TCO priority.
 *
 * Coralogix bills in *units*: every GB that arrives is converted to units at a
 * rate set by its pillar and the TCO priority its policy routes it to (logs:
 * 0.75 units per GB at High, 0.32 at Medium, 0.12 at Low; traces 0.5 / 0.25 /
 * 0.1; metrics 1 unit per 30 GB), and units count against the team's daily
 * quota (https://coralogix.com/docs/user-guides/account-management/payment-and-billing/data-usage/).
 *
 * Two endpoints read it, verified against Coralogix's published OpenAPI
 * documents (`/mgmt/openapi/4/openapi.yaml` and `/mgmt/openapi/5/openapi.yaml`,
 * 2026-10) and the `com.coralogix.datausage.v2` protos in
 * coralogix/coralogix-management-sdk:
 *
 * - **`POST /dataplans/data-usage/v2/daily/units`** and its twin
 *   **`.../daily/processed-gbs`** (documented in API version 4) return one row
 *   per UTC day with a fixed field per pillar and priority
 *   (`highLogsUnits`, `mediumTracingUnits`, `highMetricsUnits`,
 *   `lowSessionRecordingUnits`, `cpuProfilesUnits`, `evaluationUnits`,
 *   `blockedUnits`, `blockedMetricsUnits`) plus `totalUnits`. This is the
 *   primary path: the breakdown is exactly the one the bill is made of.
 * - **`POST /dataplan/data-usage/v1/query`** (version 5, the current API) is
 *   the successor: bucketed daily usage grouped by labels the server lists at
 *   `GET .../v1/capabilities`. It is used only when the version 4 route is
 *   gone (404/405/501), grouping by whichever pillar and priority labels the
 *   capabilities advertise, so a retired endpoint degrades to the same cells
 *   rather than to nothing.
 *
 * **`totalUnits` is authoritative.** The per-field breakdown does not say
 * whether `blockedUnits` already includes `blockedMetricsUnits`, nor whether
 * blocked data is inside the total. So every fine-grained field except
 * `blockedUnits` becomes a cell, and whatever the total has left over becomes
 * one "blocked" cell (or "other" on a day that blocked nothing). The cells of
 * a day therefore always sum to Coralogix's own total for it, which is the
 * number the quota and the invoice are computed from.
 */

import type { CoralogixContext } from "./api.js";
import { cxFetch, isMissingRoute } from "./api.js";

export type Pillar = "logs" | "metrics" | "traces" | "binary" | "profiles" | "ai" | "other";
export type Priority = "high" | "medium" | "low" | "blocked";

/** One day's units (and GB, where reported) for one pillar and priority. */
export interface UsageCell {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  pillar: Pillar;
  priority?: Priority;
  units: number;
  gb?: number;
}

/** Human names, as Coralogix uses them in its Data Usage page. */
export const PILLAR_LABELS: Record<Pillar, string> = {
  logs: "Logs",
  metrics: "Metrics",
  traces: "Traces",
  binary: "Session Recordings",
  profiles: "Profiles",
  ai: "AI Evaluations",
  other: "Other",
};

/**
 * TCO priorities by the names the TCO Optimizer gives them: High priority
 * data is fully indexed for Frequent Search, Medium is kept for Monitoring
 * (alerts, dashboards, metrics from logs), Low goes straight to the archive
 * for Compliance. Blocked data is dropped but still costs a little to process.
 */
export const PRIORITY_LABELS: Record<Priority, string> = {
  high: "Frequent Search",
  medium: "Monitoring",
  low: "Compliance",
  blocked: "Blocked",
};

interface Value {
  value?: number;
}

/** One row of `daily/units` (field names per the version 4 OpenAPI document). */
export interface DailyUnitsRow {
  statsDate?: string;
  totalUnits?: Value;
  blockedUnits?: Value;
  lowLogsUnits?: Value;
  mediumLogsUnits?: Value;
  highLogsUnits?: Value;
  highMetricsUnits?: Value;
  lowTracingUnits?: Value;
  mediumTracingUnits?: Value;
  highTracingUnits?: Value;
  lowSessionRecordingUnits?: Value;
  evaluationUnits?: Value;
  cpuProfilesUnits?: Value;
  blockedMetricsUnits?: Value;
}

/** One row of `daily/processed-gbs`. */
export interface DailyGbsRow {
  statsDate?: string;
  totalGbs?: Value;
  blockedGbs?: Value;
  lowLogsGbs?: Value;
  mediumLogsGbs?: Value;
  highLogsGbs?: Value;
  highMetricsGbs?: Value;
  lowTracingGbs?: Value;
  mediumTracingGbs?: Value;
  highTracingGbs?: Value;
  lowSessionRecordingGbs?: Value;
  cpuProfilesGbs?: Value;
  blockedMetricsGbs?: Value;
}

interface FieldMap {
  units: keyof DailyUnitsRow;
  gb?: keyof DailyGbsRow;
  pillar: Pillar;
  priority?: Priority;
}

/** Every fine-grained field except `blockedUnits`, which the total settles. */
const FIELDS: FieldMap[] = [
  { units: "highLogsUnits", gb: "highLogsGbs", pillar: "logs", priority: "high" },
  { units: "mediumLogsUnits", gb: "mediumLogsGbs", pillar: "logs", priority: "medium" },
  { units: "lowLogsUnits", gb: "lowLogsGbs", pillar: "logs", priority: "low" },
  { units: "highMetricsUnits", gb: "highMetricsGbs", pillar: "metrics", priority: "high" },
  {
    units: "blockedMetricsUnits",
    gb: "blockedMetricsGbs",
    pillar: "metrics",
    priority: "blocked",
  },
  { units: "highTracingUnits", gb: "highTracingGbs", pillar: "traces", priority: "high" },
  { units: "mediumTracingUnits", gb: "mediumTracingGbs", pillar: "traces", priority: "medium" },
  { units: "lowTracingUnits", gb: "lowTracingGbs", pillar: "traces", priority: "low" },
  {
    units: "lowSessionRecordingUnits",
    gb: "lowSessionRecordingGbs",
    pillar: "binary",
    priority: "low",
  },
  { units: "cpuProfilesUnits", gb: "cpuProfilesGbs", pillar: "profiles" },
  { units: "evaluationUnits", pillar: "ai" },
];

/** Below this a remainder is float noise from summing single-precision fields. */
const EPSILON = 1e-6;

const num = (v: Value | undefined): number => {
  const n = v?.value;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};

function dayOf(stamp: string | undefined): string | undefined {
  if (!stamp) return undefined;
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : undefined;
}

/** First instant of the UTC day after `date`. */
export function nextDayIso(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString();
}

/** Turn one day's `daily/units` (and matching `processed-gbs`) row into cells. */
export function cellsFromDailyRows(units: DailyUnitsRow, gbs?: DailyGbsRow): UsageCell[] {
  const date = dayOf(units.statsDate);
  if (!date) return [];
  const cells: UsageCell[] = [];
  let unitSum = 0;
  let gbSum = 0;
  for (const f of FIELDS) {
    const u = num(units[f.units] as Value | undefined);
    const g = f.gb && gbs ? num(gbs[f.gb] as Value | undefined) : undefined;
    unitSum += u;
    gbSum += g ?? 0;
    if (u <= EPSILON && (g ?? 0) <= EPSILON) continue;
    cells.push({
      date,
      pillar: f.pillar,
      ...(f.priority ? { priority: f.priority } : {}),
      units: u,
      ...(g !== undefined ? { gb: g } : {}),
    });
  }
  const total = units.totalUnits?.value;
  const blocked = num(units.blockedUnits);
  if (typeof total === "number" && Number.isFinite(total)) {
    const remainder = total - unitSum;
    if (remainder > EPSILON) {
      const totalGb = gbs?.totalGbs?.value;
      const gbRemainder =
        typeof totalGb === "number" && Number.isFinite(totalGb)
          ? Math.max(0, totalGb - gbSum)
          : undefined;
      cells.push({
        date,
        pillar: blocked > EPSILON ? "logs" : "other",
        ...(blocked > EPSILON ? { priority: "blocked" as const } : {}),
        units: remainder,
        ...(gbRemainder !== undefined && gbRemainder > EPSILON ? { gb: gbRemainder } : {}),
      });
    }
  } else if (blocked > EPSILON) {
    // No total to settle against: count blocked units net of the metrics
    // share that already has its own cell, never below zero.
    const metricsBlocked = num(units.blockedMetricsUnits);
    const rest = blocked >= metricsBlocked ? blocked - metricsBlocked : blocked;
    if (rest > EPSILON) {
      const blockedGb = gbs ? num(gbs.blockedGbs) - num(gbs.blockedMetricsGbs) : undefined;
      cells.push({
        date,
        pillar: "logs",
        priority: "blocked",
        units: rest,
        ...(blockedGb !== undefined && blockedGb > EPSILON ? { gb: blockedGb } : {}),
      });
    }
  }
  return cells;
}

/** Inclusive date range, `YYYY-MM-DD`. */
export interface DayRange {
  fromDate: string;
  toDate: string;
}

async function fetchV4(ctx: CoralogixContext, range: DayRange): Promise<UsageCell[]> {
  const body = {
    dateRange: {
      fromDate: `${range.fromDate}T00:00:00.000Z`,
      // Exclusive next midnight, so the last day is whole whichever way the
      // server reads the bound; rows outside the range are filtered below.
      toDate: nextDayIso(range.toDate),
    },
  };
  const [units, gbs] = await Promise.all([
    cxFetch<{ units?: DailyUnitsRow[] }>(ctx, "/dataplans/data-usage/v2/daily/units", {
      method: "POST",
      body,
      version: 4,
    }),
    cxFetch<{ gbs?: DailyGbsRow[] }>(ctx, "/dataplans/data-usage/v2/daily/processed-gbs", {
      method: "POST",
      body,
      version: 4,
    }).catch(() => ({ gbs: [] as DailyGbsRow[] })),
  ]);
  const gbByDay = new Map<string, DailyGbsRow>();
  for (const row of gbs?.gbs ?? []) {
    const d = dayOf(row.statsDate);
    if (d) gbByDay.set(d, row);
  }
  const out: UsageCell[] = [];
  for (const row of units?.units ?? []) {
    const d = dayOf(row.statsDate);
    if (!d || d < range.fromDate || d > range.toDate) continue;
    out.push(...cellsFromDailyRows(row, gbByDay.get(d)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Version 5 fallback
// ---------------------------------------------------------------------------

interface CapabilityLabel {
  key?: string;
}

interface QueryEntry {
  labels?: Array<{ key?: string; value?: string }>;
  measurements?: Array<{
    kind?: string;
    cxQuotaUnits?: { value?: string };
    measuredUnit?: string;
    measuredValue?: string;
  }>;
}

interface QueryResponse {
  buckets?: Array<{ range?: { start?: string }; entries?: QueryEntry[] }>;
}

const PILLAR_KEYS = ["pillar"];
const PRIORITY_KEYS = ["priority", "tco_priority", "tier", "tco_tier", "pipeline"];

/** Map a label value from the v5 API onto our pillar vocabulary. */
export function normalisePillar(raw: string | undefined): Pillar {
  const v = (raw ?? "").toLowerCase().replace(/^pillar_/, "");
  if (v.startsWith("log")) return "logs";
  if (v.startsWith("metric")) return "metrics";
  if (v.startsWith("span") || v.startsWith("trac")) return "traces";
  if (v.startsWith("binar") || v.includes("session")) return "binary";
  if (v.startsWith("profil")) return "profiles";
  if (v.includes("eval") || v.includes("ai") || v.includes("olly")) return "ai";
  return "other";
}

export function normalisePriority(raw: string | undefined): Priority | undefined {
  const v = (raw ?? "").toLowerCase().replace(/^(priority|tco_tier|priority_type)_/, "");
  if (v.startsWith("high") || v.includes("frequent")) return "high";
  if (v.startsWith("med") || v.includes("monitor")) return "medium";
  if (v.startsWith("low") || v.includes("compliance") || v.includes("archive")) return "low";
  if (v.startsWith("block")) return "blocked";
  return undefined;
}

function ymd(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return { year, month, day };
}

async function fetchV5(ctx: CoralogixContext, range: DayRange): Promise<UsageCell[]> {
  const caps = await cxFetch<{ supportedLabels?: CapabilityLabel[] }>(
    ctx,
    "/dataplan/data-usage/v1/capabilities",
  );
  const keys = new Set((caps?.supportedLabels ?? []).map((l) => l.key ?? "").filter(Boolean));
  const pillarKey = PILLAR_KEYS.find((k) => keys.has(k));
  const priorityKey = PRIORITY_KEYS.find((k) => keys.has(k));
  const groupBy = [pillarKey, priorityKey].filter((k): k is string => !!k);
  const end = nextDayIso(range.toDate).slice(0, 10);
  const res = await cxFetch<QueryResponse>(ctx, "/dataplan/data-usage/v1/query", {
    method: "POST",
    body: {
      daily: { dateRange: { start: ymd(range.fromDate), end: ymd(end) } },
      ...(groupBy.length > 0 ? { groupBy: { keys: groupBy } } : {}),
    },
  });
  const cells = new Map<string, UsageCell>();
  for (const bucket of res?.buckets ?? []) {
    const date = dayOf(bucket.range?.start);
    if (!date || date < range.fromDate || date > range.toDate) continue;
    for (const entry of bucket.entries ?? []) {
      const label = (k: string | undefined) =>
        k ? entry.labels?.find((l) => l.key === k)?.value : undefined;
      const pillar = pillarKey ? normalisePillar(label(pillarKey)) : "other";
      const priority = priorityKey ? normalisePriority(label(priorityKey)) : undefined;
      let units = 0;
      let bytes = 0;
      for (const m of entry.measurements ?? []) {
        const u = Number(m.cxQuotaUnits?.value ?? 0);
        if (Number.isFinite(u)) units += u;
        if (m.measuredUnit === "MEASUREMENT_UNIT_BYTES") {
          const b = Number(m.measuredValue ?? 0);
          if (Number.isFinite(b)) bytes += b;
        }
      }
      if (units <= EPSILON && bytes <= 0) continue;
      const key = `${date}|${pillar}|${priority ?? ""}`;
      const existing = cells.get(key);
      const gb = bytes / 1e9;
      if (existing) {
        existing.units += units;
        existing.gb = (existing.gb ?? 0) + gb;
      } else {
        cells.set(key, {
          date,
          pillar,
          ...(priority ? { priority } : {}),
          units,
          ...(bytes > 0 ? { gb } : {}),
        });
      }
    }
  }
  return [...cells.values()];
}

/**
 * Usage cells for an inclusive range. Callers keep ranges to about a month
 * (see `cost-data.ts`); the server enforces its own per-request limits.
 */
export async function fetchUsageCells(
  ctx: CoralogixContext,
  range: DayRange,
): Promise<UsageCell[]> {
  try {
    return await fetchV4(ctx, range);
  } catch (err) {
    if (!isMissingRoute(err)) throw err;
    return fetchV5(ctx, range);
  }
}

/** Sum cells by day, for charts and quota readings. */
export function totalsByDay(cells: UsageCell[]): Map<string, { units: number; gb: number }> {
  const out = new Map<string, { units: number; gb: number }>();
  for (const c of cells) {
    const t = out.get(c.date) ?? { units: 0, gb: 0 };
    t.units += c.units;
    t.gb += c.gb ?? 0;
    out.set(c.date, t);
  }
  return out;
}
