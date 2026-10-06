import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import { isStatus, type RunpodApi } from "./api.js";
import type { RpBillingRecord } from "./types.js";

/**
 * Billed spend from Runpod's REST billing history (verified in the OpenAPI
 * document, 2026-10). Three endpoints, each bucketed by day:
 *
 * - `GET /billing/pods?grouping=podId`: per-pod charges (GPU or CPU time
 *   plus the pod's disk), with `timeBilledMs`.
 * - `GET /billing/endpoints?grouping=endpointId`: per-endpoint Serverless
 *   charges.
 * - `GET /billing/networkvolumes`: account-wide network storage, split into
 *   standard and high-performance storage.
 *
 * `amount` is USD. `time` is the bucket start (UTC). Runpod documents no
 * retention limit; a year is requested at most.
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
  /** Data center of each pod or endpoint still in inventory. */
  regions: Map<string, string>;
  /** Display name of each pod or endpoint still in inventory. */
  names: Map<string, string>;
}

export function mapComputeRecords(
  records: RpBillingRecord[] | undefined,
  service: "Pods" | "Serverless",
  key: "podId" | "endpointId",
  range: CostFetchRange,
  ctx: CostContext,
): CostRow[] {
  const rows: CostRow[] = [];
  for (const r of records ?? []) {
    const date = dayOf(r.time);
    if (!date || !inRange(date, range)) continue;
    if (typeof r.amount !== "number" || !Number.isFinite(r.amount) || r.amount === 0) continue;
    const id = r[key] ?? "";
    const region = id ? ctx.regions.get(id) : undefined;
    const name = id ? ctx.names.get(id) : undefined;
    rows.push({
      date,
      service,
      ...(region ? { region } : {}),
      ...(id ? { resourceId: id } : {}),
      ...(name ? { tags: { resource_name: name } } : {}),
      currency: "USD",
      amount: round(r.amount),
      ...(typeof r.timeBilledMs === "number" && r.timeBilledMs > 0
        ? { usageAmount: round(r.timeBilledMs / 3_600_000), usageUnit: "hours" }
        : {}),
    });
  }
  return rows;
}

export function mapVolumeRecords(
  records: RpBillingRecord[] | undefined,
  range: CostFetchRange,
): CostRow[] {
  const rows: CostRow[] = [];
  for (const r of records ?? []) {
    const date = dayOf(r.time);
    if (!date || !inRange(date, range)) continue;
    const hp =
      typeof r.highPerformanceStorageAmount === "number" ? r.highPerformanceStorageAmount : 0;
    const total = typeof r.amount === "number" && Number.isFinite(r.amount) ? r.amount : 0;
    // `amount` is the standard-storage charge; high-performance storage is a
    // separate figure next to it.
    if (total > 0) {
      rows.push({
        date,
        service: "Network Volumes",
        currency: "USD",
        amount: round(total),
        ...(r.diskSpaceBilledGb ? { usageAmount: r.diskSpaceBilledGb, usageUnit: "GB" } : {}),
      });
    }
    if (hp > 0) {
      rows.push({
        date,
        service: "High Performance Storage",
        currency: "USD",
        amount: round(hp),
        ...(r.highPerformanceStorageDiskSpaceBilledGb
          ? { usageAmount: r.highPerformanceStorageDiskSpaceBilledGb, usageUnit: "GB" }
          : {}),
      });
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

export async function fetchRunpodCostData(
  api: RunpodApi,
  range: CostFetchRange,
  ctx: CostContext,
): Promise<CostRow[]> {
  const window = {
    bucketSize: "day",
    startTime: `${range.fromDate}T00:00:00Z`,
    endTime: `${nextDay(range.toDate)}T00:00:00Z`,
  };
  let pods: RpBillingRecord[];
  try {
    pods = await api.rest<RpBillingRecord[]>("/billing/pods", {
      query: { ...window, grouping: "podId" },
    });
  } catch (e) {
    if (isStatus(e, 401, 403)) {
      throw new CostSetupError(
        "Runpod refused the billing history for this API key. Billing needs a key with All or Read Only permission (not a Restricted key).",
        { label: "Open Runpod API keys", url: "https://console.runpod.io/user/settings" },
      );
    }
    throw e;
  }
  const [endpoints, volumes] = await Promise.all([
    api.rest<RpBillingRecord[]>("/billing/endpoints", {
      query: { ...window, grouping: "endpointId" },
    }),
    api.rest<RpBillingRecord[]>("/billing/networkvolumes", { query: window }),
  ]);
  return aggregateRows([
    ...mapComputeRecords(pods, "Pods", "podId", range, ctx),
    ...mapComputeRecords(endpoints, "Serverless", "endpointId", range, ctx),
    ...mapVolumeRecords(volumes, range),
  ]);
}
