import type { CostFetchRange, CostFetchResult, CostRow } from "@infrawrench/plugin-base";
import type { NorthflankContext } from "./api.js";
import { nfFetch } from "./api.js";
import type { NfProject, NfUsageEntry } from "./types.js";

/**
 * Daily spend from `GET /v1/billing/usage?granularity=day` (verified
 * 2026-10). Each entry is one UTC day with prices already in money:
 *
 * - `paas.price.{cpu,memory,storage,gpu}`: Northflank-hosted workloads.
 * - `byoc.price.total`, `egressIp.price.total`, `loadBalancer.price.total`:
 *   customer-level charges, which the API omits whenever a project filter is
 *   active (and for team-scoped callers).
 *
 * The PaaS share is attributed to projects by repeating the query with
 * `projectId=<project uid>` (the 24-character `uid`, not the slug). Whatever
 * the per-project rows do not cover (deleted projects, rounding) stays as an
 * unattributed row, so the daily total always matches the account total.
 */

const PAAS_PARTS: Array<{ key: string; service: string }> = [
  { key: "cpu", service: "Compute (CPU)" },
  { key: "memory", service: "Compute (memory)" },
  { key: "storage", service: "Storage" },
  { key: "gpu", service: "GPU" },
];

const CUSTOMER_PARTS: Array<{ key: "byoc" | "egressIp" | "loadBalancer"; service: string }> = [
  { key: "byoc", service: "BYOC" },
  { key: "egressIp", service: "Egress IPs" },
  { key: "loadBalancer", service: "Load balancers" },
];

/** Above this many projects the per-project fan-out would eat the hourly API budget. */
export const MAX_ATTRIBUTED_PROJECTS = 40;

const DAY = 86_400;

function dayOf(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Walk every daily bucket between the two unix timestamps (end exclusive). */
export async function fetchDailyUsage(
  ctx: NorthflankContext,
  startTime: number,
  endTime: number,
  projectUid?: string,
): Promise<NfUsageEntry[]> {
  const out: NfUsageEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await nfFetch<{
      data?: { usage?: NfUsageEntry[] };
      pagination?: { hasNextPage?: boolean; cursor?: string };
    }>(ctx, "GET", "/v1/billing/usage", {
      query: {
        granularity: "day",
        startTime,
        endTime,
        perPage: 100,
        removeLegacyFields: true,
        ...(projectUid ? { projectId: projectUid } : {}),
        ...(cursor ? { cursor } : {}),
      },
    });
    out.push(...(res?.data?.usage ?? []));
    if (!res?.pagination?.hasNextPage || !res.pagination.cursor) break;
    cursor = res.pagination.cursor;
  }
  return out;
}

export async function fetchNorthflankCostData(
  ctx: NorthflankContext,
  range: CostFetchRange,
  listProjects: () => Promise<NfProject[]>,
): Promise<CostRow[] | CostFetchResult> {
  const startTime = Math.floor(Date.parse(`${range.fromDate}T00:00:00Z`) / 1000);
  const endTime = Math.floor(Date.parse(`${range.toDate}T00:00:00Z`) / 1000) + DAY;
  const account = await fetchDailyUsage(ctx, startTime, endTime);
  const rows: CostRow[] = [];
  const inRange = (date: string) => date >= range.fromDate && date <= range.toDate;

  // Project-attributed PaaS rows, and what they cover per day and part.
  const covered = new Map<string, number>();
  let degraded = false;
  let projects: NfProject[] = [];
  try {
    projects = (await listProjects()).filter((p) => p.uid);
  } catch {
    degraded = true;
  }
  if (projects.length > MAX_ATTRIBUTED_PROJECTS) projects = [];
  for (const project of projects) {
    let entries: NfUsageEntry[];
    try {
      entries = await fetchDailyUsage(ctx, startTime, endTime, project.uid);
    } catch {
      degraded = true;
      continue;
    }
    for (const e of entries) {
      if (typeof e.timestamp !== "number") continue;
      const date = dayOf(e.timestamp);
      if (!inRange(date)) continue;
      for (const part of PAAS_PARTS) {
        const amount = Number(e.paas?.price?.[part.key] ?? 0);
        if (!amount) continue;
        covered.set(`${date}|${part.key}`, (covered.get(`${date}|${part.key}`) ?? 0) + amount);
        rows.push({
          date,
          service: part.service,
          resourceId: project.id ?? project.uid ?? "",
          currency: (e.currency ?? "USD").toUpperCase(),
          amount: round(amount),
          tags: { project: project.name ?? project.id ?? "" },
        });
      }
    }
  }

  for (const e of account) {
    if (typeof e.timestamp !== "number") continue;
    const date = dayOf(e.timestamp);
    if (!inRange(date)) continue;
    const currency = (e.currency ?? "USD").toUpperCase();
    for (const part of PAAS_PARTS) {
      const total = Number(e.paas?.price?.[part.key] ?? 0);
      const rest = round(total - (covered.get(`${date}|${part.key}`) ?? 0));
      if (Math.abs(rest) < 0.01) continue;
      rows.push({ date, service: part.service, currency, amount: rest });
    }
    for (const part of CUSTOMER_PARTS) {
      const amount = Number(e[part.key]?.price?.["total"] ?? 0);
      if (!amount) continue;
      rows.push({ date, service: part.service, currency, amount: round(amount) });
    }
  }
  return degraded ? { rows, degraded: true } : rows;
}
