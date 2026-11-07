import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import { isStatus, type RunpodApi } from "./api.js";
import type {
  RpPodBillingRecord,
  RpServerlessBillingRecord,
  RpVolumeBillingRecord,
} from "./types.js";

/**
 * Billed spend from Runpod's REST billing history (verified in the OpenAPI
 * document, 2026-11). Three endpoints, each bucketed by day, one record per
 * object per bucket:
 *
 * - `GET /v2/billing/pods`: per-pod charges (GPU or CPU time plus the pod's disk).
 * - `GET /v2/billing/serverless`: per-endpoint Serverless charges. `/billing/endpoints`
 *   answers too, but it is Public Endpoint billing, so reading it for this would give
 *   wrong costs with no error.
 * - `GET /v2/billing/network-volumes`: per-volume storage, split into standard and
 *   high-performance. `totalAmount` is the two together.
 *
 * Amounts are USD. `startTime` is the bucket start (UTC). No route pages. Runpod
 * documents no retention limit; a year is requested at most. REST v2 reports no
 * hours or GB billed per object, so these rows carry no usage amount.
 */

export const BILLING_URL = "https://console.runpod.io/user/billing";

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function dayOf(time: string | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(time ?? "");
  return m ? m[1]! : null;
}

function inRange(date: string, range: CostFetchRange): boolean {
  return date >= range.fromDate && date <= range.toDate;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface CostContext {
  /** Data center of each pod, endpoint or network volume still in inventory. */
  regions: Map<string, string>;
  /** Display name of each pod, endpoint or network volume still in inventory. */
  names: Map<string, string>;
}

export function mapComputeRecords<Record extends { startTime?: string; totalAmount?: number }>(
  records: Record[] | undefined,
  service: "Pods" | "Serverless",
  idOf: (record: Record) => string | undefined,
  range: CostFetchRange,
  ctx: CostContext,
): CostRow[] {
  const rows: CostRow[] = [];
  for (const r of records ?? []) {
    const date = dayOf(r.startTime);
    if (!date || !inRange(date, range)) continue;
    const amount = r.totalAmount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount === 0) continue;
    const id = idOf(r) ?? "";
    const region = id ? ctx.regions.get(id) : undefined;
    const name = id ? ctx.names.get(id) : undefined;
    rows.push({
      date,
      service,
      ...(region ? { region } : {}),
      ...(id ? { resourceId: id } : {}),
      ...(name ? { tags: { resource_name: name } } : {}),
      currency: "USD",
      amount: round(amount),
    });
  }
  return rows;
}

function finite(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

export function mapVolumeRecords(
  records: RpVolumeBillingRecord[] | undefined,
  range: CostFetchRange,
  ctx: CostContext,
): CostRow[] {
  const rows: CostRow[] = [];
  for (const r of records ?? []) {
    const date = dayOf(r.startTime);
    if (!date || !inRange(date, range)) continue;
    const id = r.networkVolumeId ?? "";
    const region = id ? ctx.regions.get(id) : undefined;
    const name = id ? ctx.names.get(id) : undefined;
    const row = {
      date,
      ...(region ? { region } : {}),
      ...(id ? { resourceId: id } : {}),
      ...(name ? { tags: { resource_name: name } } : {}),
      currency: "USD",
    };
    const highPerformance = finite(r.highPerformanceAmount);
    // Never `totalAmount` beside it: that already includes high-performance storage.
    const standard =
      typeof r.standardAmount === "number"
        ? finite(r.standardAmount)
        : finite(r.totalAmount) - highPerformance;
    if (standard > 0) rows.push({ ...row, service: "Network Volumes", amount: round(standard) });
    if (highPerformance > 0) {
      rows.push({ ...row, service: "High Performance Storage", amount: round(highPerformance) });
    }
  }
  return rows;
}

/** Same-key rows collapse in the host's store, so sum them first. */
export function aggregateRows(rows: CostRow[]): CostRow[] {
  const byKey = new Map<string, CostRow>();
  for (const r of rows) {
    const key = [
      r.date,
      r.service ?? "",
      r.region ?? "",
      r.resourceId ?? "",
      r.usageUnit ?? "",
    ].join("|");
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r });
      continue;
    }
    prev.amount = round(prev.amount + r.amount);
    if (r.usageAmount !== undefined) {
      prev.usageAmount = round((prev.usageAmount ?? 0) + r.usageAmount);
    }
  }
  return [...byKey.values()];
}

/** A 200 with no list is not a day with no spend, and restated days replace what is stored. */
function recordsOf<Record>(path: string, answer: { records: Record[] }): Record[] {
  const records = answer?.records;
  if (!Array.isArray(records)) {
    throw new Error(`Runpod answered ${path} with no list of billing records`);
  }
  return records;
}

export async function fetchRunpodCostData(
  api: RunpodApi,
  range: CostFetchRange,
  ctx: CostContext,
): Promise<CostRow[]> {
  const window = {
    bucketSize: "day" as const,
    startTime: `${range.fromDate}T00:00:00Z`,
    endTime: `${nextDay(range.toDate)}T00:00:00Z`,
  };
  let pods: RpPodBillingRecord[];
  try {
    pods = recordsOf("/v2/billing/pods", await api.rest.get("/v2/billing/pods", { query: window }));
  } catch (e) {
    if (isStatus(e, 401, 403)) {
      throw new CostSetupError(
        "Runpod refused the billing history for this API key. Billing needs a key with All or Read Only permission (not a Restricted key).",
        { label: "Open Runpod API keys", url: "https://console.runpod.io/user/settings" },
      );
    }
    throw e;
  }
  const [serverless, volumes] = await Promise.all([
    api.rest.get("/v2/billing/serverless", { query: window }),
    api.rest.get("/v2/billing/network-volumes", { query: window }),
  ]);
  const endpoints: RpServerlessBillingRecord[] = recordsOf("/v2/billing/serverless", serverless);
  return aggregateRows([
    ...mapComputeRecords(pods, "Pods", (r) => r.podId, range, ctx),
    ...mapComputeRecords(endpoints, "Serverless", (r) => r.serverlessId, range, ctx),
    ...mapVolumeRecords(recordsOf("/v2/billing/network-volumes", volumes), range, ctx),
  ]);
}
