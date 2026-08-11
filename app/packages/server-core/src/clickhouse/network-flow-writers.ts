import type { NetworkFlowDailyRow } from "../network-flow/aggregate";
import { getClickHouseClient, isClickHouseConfigured } from "./client";

/** A `network_flow_daily` row, as ClickHouse takes it. */
export interface NetworkFlowClickHouseRow {
  organization_id: string;
  account_id: string;
  plugin_id: string;
  day: string;
  scope: string;
  direction: string;
  attribution: string;
  pair_hash: string;
  src_ref: string;
  src_label: string;
  src_zone: string;
  src_region: string;
  src_service: string;
  src_resource_type_id: string;
  dst_ref: string;
  dst_label: string;
  dst_zone: string;
  dst_region: string;
  dst_service: string;
  dst_resource_type_id: string;
  bytes: number;
  packets: number;
  currency: string;
  rate_per_gb: number;
  estimated_cost: number;
}

export interface NetworkFlowRowMeta {
  organizationId: string;
  accountId: string;
  pluginId: string;
}

/**
 * Map aggregated rows onto the stored shape.
 *
 * Byte and packet counts are floored to integers because the columns are
 * `UInt64` and ClickHouse rejects a fractional value there rather than
 * truncating it. A residual computed by subtraction can carry a fraction when a
 * provider reports totals as floats, and losing under a byte per row is not a
 * number anyone will ever look at.
 */
export function toNetworkFlowRows(
  meta: NetworkFlowRowMeta,
  rows: NetworkFlowDailyRow[],
): NetworkFlowClickHouseRow[] {
  return rows.map((r) => ({
    organization_id: meta.organizationId,
    account_id: meta.accountId,
    plugin_id: meta.pluginId,
    day: r.day,
    scope: r.scope,
    direction: r.direction,
    attribution: r.attribution,
    pair_hash: r.pairHash,
    src_ref: r.srcRef,
    src_label: r.srcLabel,
    src_zone: r.srcZone,
    src_region: r.srcRegion,
    src_service: r.srcService,
    src_resource_type_id: r.srcResourceTypeId,
    dst_ref: r.dstRef,
    dst_label: r.dstLabel,
    dst_zone: r.dstZone,
    dst_region: r.dstRegion,
    dst_service: r.dstService,
    dst_resource_type_id: r.dstResourceTypeId,
    bytes: Math.floor(r.bytes),
    packets: Math.floor(r.packets),
    currency: r.currency,
    rate_per_gb: r.ratePerGb,
    estimated_cost: r.estimatedCost,
  }));
}

/**
 * Insert a day's rows. Errors propagate: the flow pass is forward-only and
 * advances a watermark on success, so a swallowed insert failure would mark the
 * day collected and there is no restatement window that would ever come back
 * for it.
 */
export async function insertNetworkFlowRows(rows: NetworkFlowClickHouseRow[]): Promise<void> {
  if (!isClickHouseConfigured() || rows.length === 0) return;
  await getClickHouseClient().insert({
    table: "network_flow_daily",
    values: rows,
    format: "JSONEachRow",
  });
}
