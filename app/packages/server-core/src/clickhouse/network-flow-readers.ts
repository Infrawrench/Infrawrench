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
import { getClickHouseClient, isClickHouseConfigured } from "./client";

async function query<T>(sql: string, query_params: Record<string, unknown>): Promise<T[]> {
  if (!isClickHouseConfigured()) return [];
  const rs = await getClickHouseClient().query({ query: sql, query_params, format: "JSONEachRow" });
  return await rs.json<T>();
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
}

function whereClause(
  organizationId: string,
  range: NetworkFlowRange,
  filters: NetworkFlowFilters,
  params: Record<string, unknown>,
): string {
  params["org"] = organizationId;
  params["from"] = range.from;
  params["to"] = range.to;
  const parts = ["organization_id = {org:String}", "day >= {from:Date}", "day <= {to:Date}"];
  if (filters.accountId) {
    params["accountId"] = filters.accountId;
    parts.push("account_id = {accountId:String}");
  }
  if (filters.pluginId) {
    params["pluginId"] = filters.pluginId;
    parts.push("plugin_id = {pluginId:String}");
  }
  if (filters.scope) {
    params["scope"] = filters.scope;
    parts.push("scope = {scope:String}");
  }
  if (filters.direction) {
    params["direction"] = filters.direction;
    parts.push("direction = {direction:String}");
  }
  return parts.join(" AND ");
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
  const params: Record<string, unknown> = {};
  const where = whereClause(organizationId, range, filters, params);
  return query<NetworkFlowScopeTotal>(
    `SELECT scope,
            direction,
            attribution,
            sum(bytes)          AS bytes,
            sum(estimated_cost) AS estimated_cost,
            any(currency)       AS currency,
            count()             AS pair_count
     FROM network_flow_daily FINAL
     WHERE ${where}
     GROUP BY scope, direction, attribution
     ORDER BY estimated_cost DESC, bytes DESC`,
    params,
  );
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
  const params: Record<string, unknown> = {};
  const where = whereClause(organizationId, range, filters, params);
  params["limit"] = Math.max(1, Math.min(500, Math.floor(limit)));
  return query<NetworkFlowPair>(
    `SELECT any(src_ref)              AS src_ref,
            any(src_label)            AS src_label,
            any(src_zone)             AS src_zone,
            any(src_region)           AS src_region,
            any(src_service)          AS src_service,
            any(src_resource_type_id) AS src_resource_type_id,
            any(dst_ref)              AS dst_ref,
            any(dst_label)            AS dst_label,
            any(dst_zone)             AS dst_zone,
            any(dst_region)           AS dst_region,
            any(dst_service)          AS dst_service,
            any(dst_resource_type_id) AS dst_resource_type_id,
            scope,
            direction,
            any(attribution)          AS attribution,
            sum(bytes)                AS bytes,
            sum(packets)              AS packets,
            sum(estimated_cost)       AS estimated_cost,
            any(currency)             AS currency,
            any(account_id)           AS account_id,
            any(plugin_id)            AS plugin_id,
            uniqExact(day)            AS days
     FROM network_flow_daily FINAL
     WHERE ${where} AND attribution != 'truncated'
     GROUP BY scope, direction, pair_hash
     ORDER BY estimated_cost DESC, bytes DESC
     LIMIT {limit:UInt32}`,
    params,
  );
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
  const params: Record<string, unknown> = {};
  const where = whereClause(organizationId, range, filters, params);
  return query<NetworkFlowDayPoint>(
    `SELECT toString(day)       AS day,
            scope,
            sum(bytes)          AS bytes,
            sum(estimated_cost) AS estimated_cost
     FROM network_flow_daily FINAL
     WHERE ${where}
     GROUP BY day, scope
     ORDER BY day ASC, estimated_cost DESC`,
    params,
  );
}
