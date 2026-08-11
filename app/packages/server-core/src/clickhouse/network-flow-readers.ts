/**
 * Reads over `network_flow_daily`.
 *
 * Two queries, because the screen asks two questions: "where is the money
 * going" (by boundary) and "who is spending it" (by pair). Neither is derivable
 * from the other cheaply — the boundary summary must include the residual and
 * unattributed buckets to add up, and the pair list must exclude them to be a
 * list of pairs.
 *
 * Every read is `FINAL`. The table is a ReplacingMergeTree and a re-collected
 * day writes a newer `ingested_at` for the same key; without `FINAL` a day
 * collected twice reads as double its traffic until the parts happen to merge.
 */
import { and, asc, desc, eq, gte, lte, or, sql } from "drizzle-orm";
import { getClickHouseDb, isClickHouseConfigured, type ClickHouseDb } from "./client";
import { networkFlowDaily as flow } from "./schema";

async function query<T>(build: (db: ClickHouseDb) => Promise<T[]>): Promise<T[]> {
  if (!isClickHouseConfigured()) return [];
  return await build(getClickHouseDb());
}

export interface NetworkFlowRange {
  from: string;
  to: string;
}

/** Optional narrowing shared by both reads. */
export interface NetworkFlowFilters {
  accountId?: string | undefined;
  pluginId?: string | undefined;
  scope?: string | undefined;
  direction?: string | undefined;
  /**
   * Keep only pairs with this endpoint at one end — "who talks to this thing".
   *
   * A flow ref is the **provider's** resource id (`i-0abc…`), never the
   * composite id the app addresses resources by, so the caller resolves the
   * external id first. It matches either end because the row's direction is
   * relative to the pair, not to the resource being asked about.
   */
  ref?: string | undefined;
}

function whereClause(organizationId: string, range: NetworkFlowRange, filters: NetworkFlowFilters) {
  return and(
    eq(flow.organization_id, organizationId),
    gte(flow.day, range.from),
    lte(flow.day, range.to),
    filters.accountId ? eq(flow.account_id, filters.accountId) : undefined,
    filters.pluginId ? eq(flow.plugin_id, filters.pluginId) : undefined,
    filters.scope ? eq(flow.scope, filters.scope) : undefined,
    filters.direction ? eq(flow.direction, filters.direction) : undefined,
    filters.ref ? or(eq(flow.src_ref, filters.ref), eq(flow.dst_ref, filters.ref)) : undefined,
  );
}

export interface NetworkFlowScopeTotal {
  scope: string;
  direction: string;
  attribution: string;
  bytes: number;
  estimated_cost: number;
  currency: string;
  pair_count: number;
}

/**
 * Bytes and money per (scope, direction, attribution) over the range.
 *
 * `attribution` stays in the grouping rather than being summed away because
 * the three buckets mean different things to a reader: `resolved` is
 * actionable, `unattributed` is traffic we saw but could not tie to a
 * workload, and `truncated` is the tail below the storage cap. A total that
 * merged them would be correct and useless — you cannot act on a number
 * without knowing how much of it is explained.
 */
export async function readNetworkFlowScopeTotals(
  organizationId: string,
  range: NetworkFlowRange,
  filters: NetworkFlowFilters = {},
): Promise<NetworkFlowScopeTotal[]> {
  const rows = await query((db) =>
    db
      .select({
        scope: flow.scope,
        direction: flow.direction,
        attribution: flow.attribution,
        bytes: sql<string>`sum(${flow.bytes})`.as("bytes"),
        estimated_cost: sql<number>`sum(${flow.estimated_cost})`.as("estimated_cost"),
        currency: sql<string>`any(${flow.currency})`.as("currency"),
        pair_count: sql<string>`count()`.as("pair_count"),
      })
      .from(flow)
      .final()
      .where(whereClause(organizationId, range, filters))
      .groupBy(flow.scope, flow.direction, flow.attribution)
      .orderBy(desc(sql`estimated_cost`), desc(sql`bytes`)),
  );
  return rows.map((r) => ({
    scope: r.scope,
    direction: r.direction,
    attribution: r.attribution,
    bytes: Number(r.bytes),
    estimated_cost: Number(r.estimated_cost),
    currency: r.currency,
    pair_count: Number(r.pair_count),
  }));
}

export interface NetworkFlowPair {
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
  scope: string;
  direction: string;
  attribution: string;
  bytes: number;
  packets: number;
  estimated_cost: number;
  currency: string;
  account_id: string;
  plugin_id: string;
  days: number;
}

/**
 * Top pairs by estimated cost over the range.
 *
 * Truncation rows are excluded — they are not a pair and would otherwise sit
 * at the top of the list as an unclickable "everything else" entry. Their
 * weight is reported by {@link readNetworkFlowScopeTotals}, which is rendered
 * above this list precisely so the tail is accounted for before the itemization
 * is read.
 *
 * Unattributed pairs are *included*, because "2 TB left this instance for
 * somewhere we could not identify" is a finding — the second most useful one
 * this feature produces after a named pair.
 */
export async function readTopNetworkFlows(
  organizationId: string,
  range: NetworkFlowRange,
  filters: NetworkFlowFilters = {},
  limit = 50,
): Promise<NetworkFlowPair[]> {
  const rows = await query((db) =>
    db
      .select({
        src_ref: sql<string>`any(${flow.src_ref})`.as("src_ref"),
        src_label: sql<string>`any(${flow.src_label})`.as("src_label"),
        src_zone: sql<string>`any(${flow.src_zone})`.as("src_zone"),
        src_region: sql<string>`any(${flow.src_region})`.as("src_region"),
        src_service: sql<string>`any(${flow.src_service})`.as("src_service"),
        src_resource_type_id: sql<string>`any(${flow.src_resource_type_id})`.as(
          "src_resource_type_id",
        ),
        dst_ref: sql<string>`any(${flow.dst_ref})`.as("dst_ref"),
        dst_label: sql<string>`any(${flow.dst_label})`.as("dst_label"),
        dst_zone: sql<string>`any(${flow.dst_zone})`.as("dst_zone"),
        dst_region: sql<string>`any(${flow.dst_region})`.as("dst_region"),
        dst_service: sql<string>`any(${flow.dst_service})`.as("dst_service"),
        dst_resource_type_id: sql<string>`any(${flow.dst_resource_type_id})`.as(
          "dst_resource_type_id",
        ),
        scope: flow.scope,
        direction: flow.direction,
        attribution: sql<string>`any(${flow.attribution})`.as("attribution"),
        bytes: sql<string>`sum(${flow.bytes})`.as("bytes"),
        packets: sql<string>`sum(${flow.packets})`.as("packets"),
        estimated_cost: sql<number>`sum(${flow.estimated_cost})`.as("estimated_cost"),
        currency: sql<string>`any(${flow.currency})`.as("currency"),
        account_id: sql<string>`any(${flow.account_id})`.as("account_id"),
        plugin_id: sql<string>`any(${flow.plugin_id})`.as("plugin_id"),
        days: sql<string>`uniqExact(${flow.day})`.as("days"),
      })
      .from(flow)
      .final()
      .where(
        and(whereClause(organizationId, range, filters), sql`${flow.attribution} != 'truncated'`),
      )
      .groupBy(flow.scope, flow.direction, flow.pair_hash)
      .orderBy(desc(sql`estimated_cost`), desc(sql`bytes`))
      .limit(Math.max(1, Math.min(500, Math.floor(limit)))),
  );
  return rows.map((r) => ({
    ...r,
    bytes: Number(r.bytes),
    packets: Number(r.packets),
    estimated_cost: Number(r.estimated_cost),
    days: Number(r.days),
  }));
}

export interface NetworkFlowDayPoint {
  day: string;
  scope: string;
  bytes: number;
  estimated_cost: number;
}

/** The daily series behind the summary, for the trend strip on the panel. */
export async function readNetworkFlowDaily(
  organizationId: string,
  range: NetworkFlowRange,
  filters: NetworkFlowFilters = {},
): Promise<NetworkFlowDayPoint[]> {
  const rows = await query((db) =>
    db
      .select({
        day: sql<string>`toString(${flow.day})`.as("day"),
        scope: flow.scope,
        bytes: sql<string>`sum(${flow.bytes})`.as("bytes"),
        estimated_cost: sql<number>`sum(${flow.estimated_cost})`.as("estimated_cost"),
      })
      .from(flow)
      .final()
      .where(whereClause(organizationId, range, filters))
      .groupBy(sql`day`, flow.scope)
      .orderBy(asc(sql`day`), desc(sql`estimated_cost`)),
  );
  return rows.map((r) => ({
    day: r.day,
    scope: r.scope,
    bytes: Number(r.bytes),
    estimated_cost: Number(r.estimated_cost),
  }));
}
