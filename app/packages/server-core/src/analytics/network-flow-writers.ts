import { getTableColumns, sql, type InferInsertModel } from "drizzle-orm";
import type { NetworkFlowDailyRow } from "../network-flow/aggregate";
import { getAnalyticsDb } from "./client";
import { networkFlowDaily, type Complete } from "./schema";

/**
 * A `network_flow_daily` row as the collector writes it: derived from the
 * table so a new column is one every producer has to fill. `ingested_at` is
 * dropped: the server's `now()` default owns it.
 */
export type NetworkFlowStoredRow = Complete<
  Omit<InferInsertModel<typeof networkFlowDaily>, "ingested_at">
>;

export interface NetworkFlowRowMeta {
  organizationId: string;
  accountId: string;
  pluginId: string;
}

/**
 * Map aggregated rows onto the stored shape.
 *
 * Byte and packet counts are floored to integers because the columns are
 * `bigint` and Postgres rejects a fractional value there rather than
 * truncating it. A residual computed by subtraction can carry a fraction when a
 * provider reports totals as floats, and losing under a byte per row is not a
 * number anyone will ever look at.
 */
export function toNetworkFlowRows(
  meta: NetworkFlowRowMeta,
  rows: NetworkFlowDailyRow[],
): NetworkFlowStoredRow[] {
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
    method: r.method,
    src_network: r.srcNetwork,
    dst_network: r.dstNetwork,
  }));
}

/** The table's key, in `network_flow_daily_pkey`'s column order. */
const KEY = [
  networkFlowDaily.organization_id,
  networkFlowDaily.account_id,
  networkFlowDaily.day,
  networkFlowDaily.scope,
  networkFlowDaily.direction,
  networkFlowDaily.attribution,
  networkFlowDaily.pair_hash,
] as const;

/**
 * Every column outside the key, `ingested_at` included, set from the incoming
 * row. Derived from the table so a new column is replaced on re-collection
 * without anyone remembering to list it here.
 */
const REPLACED = Object.fromEntries(
  Object.entries(getTableColumns(networkFlowDaily))
    .filter(([, column]) => !(KEY as readonly unknown[]).includes(column))
    .map(([name, column]) => [name, sql.raw(`excluded."${column.name}"`)]),
);

/**
 * Rows per statement. Each row binds one parameter per column (28), and
 * Postgres caps a statement at 65,535 parameters.
 */
const BATCH_ROWS = 1000;

const keyOf = (r: NetworkFlowStoredRow) =>
  [r.organization_id, r.account_id, r.day, r.scope, r.direction, r.attribution, r.pair_hash].join(
    "\u0000",
  );

/**
 * Insert a day's rows, replacing any already stored under the same key.
 *
 * Re-collecting a day is an upsert on `network_flow_daily_pkey`: the newer
 * write's values and `ingested_at` win, and the guard on `ingested_at` keeps a
 * write that somehow started earlier from overwriting a later one. Postgres
 * refuses to touch one row twice in a statement, so a batch is deduplicated
 * first, the later row winning, as it would have across two writes.
 *
 * A day too large for one statement is written in one transaction, so a reader
 * never sees half of a re-collected day.
 *
 * Errors propagate: the flow pass is forward-only and advances a watermark on
 * success, so a swallowed insert failure would mark the day collected and
 * there is no restatement window that would ever come back for it.
 */
export async function insertNetworkFlowRows(rows: NetworkFlowStoredRow[]): Promise<void> {
  if (rows.length === 0) return;
  const unique = [...new Map(rows.map((r) => [keyOf(r), r])).values()];
  const batches: NetworkFlowStoredRow[][] = [];
  for (let i = 0; i < unique.length; i += BATCH_ROWS) {
    batches.push(unique.slice(i, i + BATCH_ROWS));
  }
  const write = async (db: Pick<ReturnType<typeof getAnalyticsDb>, "insert">) => {
    for (const batch of batches) {
      await db
        .insert(networkFlowDaily)
        .values(batch)
        .onConflictDoUpdate({
          target: [...KEY],
          set: REPLACED,
          setWhere: sql`${networkFlowDaily.ingested_at} <= excluded.ingested_at`,
        });
    }
  };
  const db = getAnalyticsDb();
  if (batches.length === 1) await write(db);
  else await db.transaction(write);
}
