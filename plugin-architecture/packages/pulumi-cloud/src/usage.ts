/**
 * Usage and estimated cost.
 *
 * Pulumi Cloud has no invoice or billing API. It does report usage per day:
 *   - `GET /api/orgs/{org}/resources/summary`: resources under management
 *     (`resources`, a daily average) and resource-hours (`resourceHours`);
 *   - `GET /api/orgs/{org}/deployments/summary`: Deployments compute minutes
 *     (reported in the same `resourceHours` field; 204 when there were none);
 *   - `GET /api/orgs/{org}/secrets/summary`: ESC secret-hours.
 * Each takes `granularity=daily` and `lookbackStart` (unix seconds, within a
 * year). Cost rows price those at the published rate for the plan picked on
 * the account (https://www.pulumi.com/pricing/, 2026-10), so they are
 * `estimated`. The plan's base fee and the credits it includes are not
 * modelled: rows are the list value of what was consumed.
 */
import type { CostFetchRange, CostRow, MetricSeries } from "@infrawrench/plugin-base";
import type { PuContext } from "./api.js";
import { enc, puRaw } from "./api.js";

export interface PlanRates {
  id: string;
  label: string;
  summary: string;
  resourceHour: number;
  secretHour: number;
  deploymentMinute: number;
}

export const PLANS: PlanRates[] = [
  {
    id: "individual",
    label: "Individual (free)",
    summary: "No charge",
    resourceHour: 0,
    secretHour: 0,
    deploymentMinute: 0,
  },
  {
    id: "essentials",
    label: "Essentials",
    summary: "$0.00025 per resource-hour",
    resourceHour: 0.00025,
    secretHour: 0.000685,
    deploymentMinute: 0.01,
  },
  {
    id: "pro",
    label: "Pro",
    summary: "$0.0005 per resource-hour",
    resourceHour: 0.0005,
    secretHour: 0.001,
    deploymentMinute: 0.01,
  },
  {
    id: "enterprise",
    label: "Enterprise",
    summary: "From $0.00075 per resource-hour",
    resourceHour: 0.00075,
    secretHour: 0.00137,
    deploymentMinute: 0.01,
  },
];

export const DEFAULT_PLAN = "pro";

/** The plan's rates, with `key=value` overrides (resourceHour, secretHour, deploymentMinute) applied. */
export function ratesFor(planId: string | undefined, overrides: string | undefined): PlanRates {
  const base =
    PLANS.find((p) => p.id === (planId || DEFAULT_PLAN)) ??
    PLANS.find((p) => p.id === DEFAULT_PLAN)!;
  const out = { ...base };
  for (const part of (overrides ?? "").split(/[\n,]/)) {
    const [k, v] = part.split("=").map((x) => x.trim());
    if (!k || v === undefined) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0)
      throw new Error(`Pulumi Cloud plugin: rate override "${part.trim()}" is not a number`);
    if (k === "resourceHour" || k === "secretHour" || k === "deploymentMinute") out[k] = n;
    else throw new Error(`Pulumi Cloud plugin: unknown rate override "${k}"`);
  }
  return out;
}

export interface DayUsage {
  date: string;
  value: number;
  /** Daily average of resources under management (resources summary only). */
  resources?: number;
}

interface SummaryRow {
  year?: number;
  month?: number;
  day?: number;
  resourceHours?: number;
  resources?: number;
}

/** One summary endpoint as daily rows; an empty (204) answer is no usage. */
export async function fetchSummary(
  ctx: PuContext,
  org: string,
  kind: "resources" | "deployments" | "secrets",
  sinceMs: number,
): Promise<DayUsage[]> {
  const floor = Date.now() - 364 * 24 * 3600 * 1000;
  const start = Math.floor(Math.max(sinceMs, floor) / 1000);
  const text = await puRaw(ctx, `/api/orgs/${enc(org)}/${kind}/summary`, {
    query: { granularity: "daily", lookbackStart: start },
  });
  if (!text) return [];
  const parsed = JSON.parse(text) as { summary?: SummaryRow[] };
  const out: DayUsage[] = [];
  for (const r of parsed.summary ?? []) {
    if (!r.year || !r.month || !r.day) continue;
    const date = `${r.year}-${String(r.month).padStart(2, "0")}-${String(r.day).padStart(2, "0")}`;
    out.push({
      date,
      value: r.resourceHours ?? 0,
      ...(typeof r.resources === "number" ? { resources: r.resources } : {}),
    });
  }
  return out;
}

export async function fetchUsageCost(
  ctx: PuContext,
  org: string,
  rates: PlanRates,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const since = Date.parse(`${range.fromDate}T00:00:00Z`);
  const [resources, deployments, secrets] = await Promise.all([
    fetchSummary(ctx, org, "resources", since),
    fetchSummary(ctx, org, "deployments", since),
    fetchSummary(ctx, org, "secrets", since),
  ]);
  const rows: CostRow[] = [];
  const add = (days: DayUsage[], service: string, unit: string, rate: number) => {
    for (const d of days) {
      if (d.date < range.fromDate || d.date > range.toDate || d.value <= 0) continue;
      rows.push({
        date: d.date,
        service,
        currency: "USD",
        amount: Math.round(d.value * rate * 1e6) / 1e6,
        usageAmount: d.value,
        usageUnit: unit,
        tags: { plan: rates.id },
      });
    }
  };
  add(resources, "IaC resources", "resource-hours", rates.resourceHour);
  add(deployments, "Deployments", "minutes", rates.deploymentMinute);
  add(secrets, "ESC secrets", "secret-hours", rates.secretHour);
  return rows;
}

/** Usage summaries as metric series for the organization's Metrics tab. */
export async function usageSeries(
  ctx: PuContext,
  org: string,
  startMs: number,
  endMs: number,
): Promise<MetricSeries[]> {
  const [resources, deployments, secrets] = await Promise.all([
    fetchSummary(ctx, org, "resources", startMs).catch(() => [] as DayUsage[]),
    fetchSummary(ctx, org, "deployments", startMs).catch(() => [] as DayUsage[]),
    fetchSummary(ctx, org, "secrets", startMs).catch(() => [] as DayUsage[]),
  ]);
  const pts = (days: DayUsage[], pick: (d: DayUsage) => number | undefined) =>
    days
      .map((d) => ({ timestamp: Date.parse(`${d.date}T00:00:00Z`), value: pick(d) }))
      .filter(
        (p): p is { timestamp: number; value: number } =>
          p.value !== undefined && p.timestamp >= startMs - 86_400_000 && p.timestamp <= endMs,
      );
  return [
    {
      label: "Resources under management",
      unit: "resources",
      points: pts(resources, (d) => d.resources),
    },
    { label: "Resource-hours", unit: "hours", points: pts(resources, (d) => d.value) },
    { label: "Deployment minutes", unit: "minutes", points: pts(deployments, (d) => d.value) },
    { label: "ESC secret-hours", unit: "hours", points: pts(secrets, (d) => d.value) },
  ].filter((s) => s.points.length > 0);
}
