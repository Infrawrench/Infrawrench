import type { CostRow } from "@infrawrench/plugin-base";
import { getClickHouseClient, isClickHouseConfigured } from "./client";

export interface CostDailyRow {
  organization_id: string;
  account_id: string;
  plugin_id: string;
  day: string;
  service: string;
  region: string;
  resource_id: string;
  tags: Record<string, string>;
  tags_hash: string;
  currency: string;
  amount: number;
  usage_amount: number;
  usage_unit: string;
}

/**
 * Stable 64-bit FNV-1a hash of a canonicalized (key-sorted, `=`/`\n`-joined)
 * tags map, as a decimal string for ClickHouse's UInt64. Deterministic across
 * processes so re-ingested rows land on the same ReplacingMergeTree key.
 */
export function hashTags(tags: Record<string, string> | undefined): string {
  if (!tags) return "0";
  const keys = Object.keys(tags).sort();
  if (keys.length === 0) return "0";
  const canonical = keys.map((k) => `${k}=${tags[k]}`).join("\n");
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(10);
}

/** Map plugin CostRows onto cost_daily rows for one account. */
export function toCostDailyRows(
  meta: { organizationId: string; accountId: string; pluginId: string },
  rows: CostRow[],
): CostDailyRow[] {
  return rows.map((r) => ({
    organization_id: meta.organizationId,
    account_id: meta.accountId,
    plugin_id: meta.pluginId,
    day: r.date,
    service: r.service ?? "",
    region: r.region ?? "",
    resource_id: r.resourceId ?? "",
    tags: r.tags ?? {},
    tags_hash: hashTags(r.tags),
    currency: r.currency,
    amount: r.amount,
    usage_amount: r.usageAmount ?? 0,
    usage_unit: r.usageUnit ?? "",
  }));
}

export async function insertCostRows(rows: CostDailyRow[]): Promise<void> {
  if (!isClickHouseConfigured() || rows.length === 0) return;
  // Unlike the fire-and-forget metric writers, cost collection must know
  // about failures so the poller can back off and retry — let errors throw.
  await getClickHouseClient().insert({ table: "cost_daily", values: rows, format: "JSONEachRow" });
}
