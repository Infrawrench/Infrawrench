import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import type { RailwayApi } from "./api.js";
import { round2 } from "./mappers.js";
import { Q_ESTIMATED_USAGE, Q_USAGE } from "./queries.js";

/**
 * Railway meters usage but never prices it through the API, so cost is
 * usage × the published container rates (docs.railway.com/reference/pricing,
 * 2026-10). The conversion is the one the official CLI uses
 * (`railwayapp/cli` src/commands/usage.rs): usage values are integrated over
 * minutes, a month is 43,200 minutes.
 *
 *   CPU_USAGE        vCPU-minutes  × $20 / 43,200
 *   MEMORY_USAGE_GB  GB-minutes    × $10 / 43,200
 *   NETWORK_TX_GB    GB egress     × $0.05
 *   DISK_USAGE_GB    GB-minutes    × $0.15 / 43,200   (volumes)
 *   BACKUP_USAGE_GB  GB-minutes    × $0.15 / 43,200
 *
 * List price only: plan credits (Hobby includes $5), discounts and the plan
 * fee are not in it, so the rows are declared `estimated`.
 */

export const MINUTES_IN_MONTH = 43_200;

export const MEASUREMENTS = [
  "CPU_USAGE",
  "MEMORY_USAGE_GB",
  "NETWORK_TX_GB",
  "DISK_USAGE_GB",
  "BACKUP_USAGE_GB",
] as const;

type Measurement = (typeof MEASUREMENTS)[number];

export const RATES: Record<Measurement, { service: string; perUnit: number; unit: string }> = {
  CPU_USAGE: { service: "CPU", perUnit: 20 / MINUTES_IN_MONTH, unit: "vCPU-minutes" },
  MEMORY_USAGE_GB: { service: "Memory", perUnit: 10 / MINUTES_IN_MONTH, unit: "GB-minutes" },
  NETWORK_TX_GB: { service: "Network Egress", perUnit: 0.05, unit: "GB" },
  DISK_USAGE_GB: {
    service: "Volume Storage",
    perUnit: 0.15 / MINUTES_IN_MONTH,
    unit: "GB-minutes",
  },
  BACKUP_USAGE_GB: { service: "Backups", perUnit: 0.15 / MINUTES_IN_MONTH, unit: "GB-minutes" },
};

interface UsageRow {
  measurement: string;
  value: number;
  tags?: { projectId?: string | null; environmentId?: string | null; serviceId?: string | null };
}

export interface NameMaps {
  projects: Map<string, string>;
  environments: Map<string, string>;
  services: Map<string, string>;
}

function days(range: CostFetchRange): string[] {
  const out: string[] = [];
  const end = Date.parse(`${range.toDate}T00:00:00Z`);
  for (let t = Date.parse(`${range.fromDate}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function usageToRows(day: string, rows: UsageRow[], names: NameMaps): CostRow[] {
  const out: CostRow[] = [];
  for (const r of rows) {
    const rate = RATES[r.measurement as Measurement];
    if (!rate || !Number.isFinite(r.value) || r.value <= 0) continue;
    const amount = r.value * rate.perUnit;
    if (amount < 0.000_001) continue;
    const projectId = r.tags?.projectId ?? "";
    const environmentId = r.tags?.environmentId ?? "";
    const serviceId = r.tags?.serviceId ?? "";
    const tags: Record<string, string> = {};
    if (projectId) tags["project"] = names.projects.get(projectId) ?? projectId;
    if (environmentId) tags["environment"] = names.environments.get(environmentId) ?? environmentId;
    if (serviceId) tags["service"] = names.services.get(serviceId) ?? serviceId;
    out.push({
      date: day,
      service: rate.service,
      ...(serviceId && environmentId ? { resourceId: `${environmentId}/${serviceId}` } : {}),
      ...(Object.keys(tags).length ? { tags } : {}),
      currency: "USD",
      amount: Math.round(amount * 1e6) / 1e6,
      usageAmount: Math.round(r.value * 1000) / 1000,
      usageUnit: rate.unit,
    });
  }
  return out;
}

/** One `usage` query per workspace per day, grouped by project, environment and service. */
export async function fetchRailwayCostData(
  api: RailwayApi,
  workspaceIds: string[],
  range: CostFetchRange,
  names: NameMaps,
): Promise<CostRow[]> {
  const out: CostRow[] = [];
  for (const day of days(range)) {
    const start = `${day}T00:00:00.000Z`;
    const end = new Date(Date.parse(start) + 86_400_000).toISOString();
    for (const workspaceId of workspaceIds) {
      const res = await api.gql<{ usage: UsageRow[] }>(Q_USAGE, {
        workspaceId,
        measurements: MEASUREMENTS,
        startDate: start,
        endDate: end,
      });
      out.push(...usageToRows(day, res.usage ?? [], names));
    }
  }
  return out;
}

/** Projected end-of-period cost at list price, from `estimatedUsage`. */
export async function fetchEstimatedBill(api: RailwayApi, workspaceId: string): Promise<number> {
  const res = await api.gql<{
    estimatedUsage: Array<{ measurement: string; estimatedValue: number }>;
  }>(Q_ESTIMATED_USAGE, { workspaceId, measurements: MEASUREMENTS });
  let total = 0;
  for (const e of res.estimatedUsage ?? []) {
    const rate = RATES[e.measurement as Measurement];
    if (rate && Number.isFinite(e.estimatedValue)) total += e.estimatedValue * rate.perUnit;
  }
  return round2(total);
}
