/**
 * Reads over `network_flow_daily` for saved network flow reports.
 *
 * Kept beside, not inside, `network-flow-readers.ts`: the feed reads one fixed
 * shape, a report reads the same rows through a filter set, a grouping and a
 * bucket size chosen by the user. Every statement here starts from
 * {@link flowOrgCondition}, so a cost visibility scope narrows a report
 * exactly as it narrows the feed (to accounts the scope grants outright).
 */
import {
  and,
  asc,
  desc,
  gte,
  inArray,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";

import { getAnalyticsDb } from "./client";
import {
  anyValue,
  flowOrgCondition,
  type NetworkFlowPair,
  type NetworkFlowRange,
} from "./network-flow-readers";
import { networkFlowDaily as flow } from "./schema";

/**
 * A report's filters as SQL sees them. Every list ORs within itself and ANDs
 * with the others; an empty or absent list does not filter. `networks`,
 * `regions` and `zones` match either end; `peerServices`/`peerResourceTypes`
 * match the peer (the destination of egress, the source of ingress).
 */
export interface NetworkFlowReportSqlFilters {
  accountIds?: string[] | undefined;
  networks?: string[] | undefined;
  regions?: string[] | undefined;
  zones?: string[] | undefined;
  sourceRefs?: string[] | undefined;
  destinationRefs?: string[] | undefined;
  peerServices?: string[] | undefined;
  peerResourceTypes?: string[] | undefined;
  scopes?: string[] | undefined;
  directions?: string[] | undefined;
  /** Re-cut plugins left out of a cross-account report (see the feed). */
  excludePluginIds?: string[] | undefined;
}

/** What a report groups by; the vocabulary of `NetworkFlowReportGroupBy`. */
export type NetworkFlowReportSplit =
  | "none"
  | "pair"
  | "source"
  | "destination"
  | "traffic_class"
  | "service"
  | "zone_pair"
  | "region_pair"
  | "account"
  | "network";

export type NetworkFlowReportBucket = "daily" | "weekly" | "monthly";

/**
 * Joins the two halves of a pair-shaped group key: `chr(31)` is U+001F, the
 * character `NETWORK_FLOW_PAIR_SEPARATOR` names. A function call rather than a
 * bind parameter, so the key expression carries no parameter of its own.
 */
const PAIR_SEPARATOR = sql`chr(31)`;

/** One of a row's two sides, chosen by direction: the peer of egress is its destination. */
function byDirection(egress: SQLWrapper, ingress: SQLWrapper): SQL<string> {
  return sql<string>`(CASE WHEN ${flow.direction} = 'egress' THEN ${egress} ELSE ${ingress} END)`;
}

const peerService = byDirection(flow.dst_service, flow.src_service);
const peerResourceType = byDirection(flow.dst_resource_type_id, flow.src_resource_type_id);
const localNetwork = byDirection(flow.src_network, flow.dst_network);

function nonEmpty(list: string[] | undefined): list is string[] {
  return Array.isArray(list) && list.length > 0;
}

function reportWhere(
  organizationId: string,
  range: NetworkFlowRange,
  f: NetworkFlowReportSqlFilters,
) {
  return and(
    flowOrgCondition(organizationId),
    gte(flow.day, range.from),
    lte(flow.day, range.to),
    nonEmpty(f.accountIds) ? inArray(flow.account_id, f.accountIds) : undefined,
    nonEmpty(f.networks)
      ? or(inArray(flow.src_network, f.networks), inArray(flow.dst_network, f.networks))
      : undefined,
    nonEmpty(f.regions)
      ? or(inArray(flow.src_region, f.regions), inArray(flow.dst_region, f.regions))
      : undefined,
    nonEmpty(f.zones)
      ? or(inArray(flow.src_zone, f.zones), inArray(flow.dst_zone, f.zones))
      : undefined,
    nonEmpty(f.sourceRefs) ? inArray(flow.src_ref, f.sourceRefs) : undefined,
    nonEmpty(f.destinationRefs) ? inArray(flow.dst_ref, f.destinationRefs) : undefined,
    nonEmpty(f.peerServices) ? inArray(peerService, f.peerServices) : undefined,
    nonEmpty(f.peerResourceTypes) ? inArray(peerResourceType, f.peerResourceTypes) : undefined,
    nonEmpty(f.scopes) ? inArray(flow.scope, f.scopes) : undefined,
    nonEmpty(f.directions) ? inArray(flow.direction, f.directions) : undefined,
    nonEmpty(f.excludePluginIds) ? notInArray(flow.plugin_id, f.excludePluginIds) : undefined,
  );
}

/** The group key expression and the two raw label parts a split carries. */
function splitExpr(split: NetworkFlowReportSplit): { key: SQL; labelA: SQL; labelB: SQL } {
  const empty = sql`''`;
  switch (split) {
    case "none":
      return { key: empty, labelA: empty, labelB: empty };
    case "pair":
      return {
        key: sql`concat(${flow.src_ref}, ${PAIR_SEPARATOR}, ${flow.dst_ref})`,
        labelA: anyValue(flow.src_label),
        labelB: anyValue(flow.dst_label),
      };
    case "source":
      return { key: sql`${flow.src_ref}`, labelA: anyValue(flow.src_label), labelB: empty };
    case "destination":
      return { key: sql`${flow.dst_ref}`, labelA: anyValue(flow.dst_label), labelB: empty };
    case "traffic_class":
      return { key: sql`${flow.scope}`, labelA: empty, labelB: empty };
    case "service":
      return { key: peerService, labelA: empty, labelB: empty };
    case "zone_pair":
      return {
        key: sql`concat(${flow.src_zone}, ${PAIR_SEPARATOR}, ${flow.dst_zone})`,
        labelA: empty,
        labelB: empty,
      };
    case "region_pair":
      return {
        key: sql`concat(${flow.src_region}, ${PAIR_SEPARATOR}, ${flow.dst_region})`,
        labelA: empty,
        labelB: empty,
      };
    case "account":
      return { key: sql`${flow.account_id}`, labelA: empty, labelB: empty };
    case "network":
      return { key: localNetwork, labelA: empty, labelB: empty };
  }
}

/**
 * The bucket a day falls in, as its first day's `YYYY-MM-DD`. Weeks start on
 * Monday (`date_trunc('week')` is ISO). The date is truncated as a `timestamp`
 * so the session time zone cannot move it across midnight.
 */
function bucketOf(bucket: NetworkFlowReportBucket): SQL {
  switch (bucket) {
    case "daily":
      return sql`to_char(${flow.day}, 'YYYY-MM-DD')`;
    case "weekly":
      return sql`to_char(date_trunc('week', ${flow.day}::timestamp), 'YYYY-MM-DD')`;
    case "monthly":
      return sql`to_char(date_trunc('month', ${flow.day}::timestamp), 'YYYY-MM-DD')`;
  }
}

/** A column summed over the rows matching `condition`; 0, not NULL, when none do. */
function sumWhere(column: SQLWrapper, condition: SQL | undefined): SQL<number> {
  return sql<number>`coalesce(sum(${column}) FILTER (WHERE ${condition}), 0)::float8`;
}

/** {@link sumWhere} over rows from a sampled source; a constant 0 when none samples. */
function sampledSum(column: SQLWrapper, sampledPluginIds: readonly string[]): SQL<number> {
  return sampledPluginIds.length > 0
    ? sumWhere(column, inArray(flow.plugin_id, [...sampledPluginIds]))
    : sql<number>`0::float8`;
}

/**
 * The six figures every report aggregate carries, as `float8` so the driver
 * hands back numbers (a `sum` of `bigint` is `numeric`, which arrives as a
 * string).
 *
 * Aliased `total_bytes` / `total_cost` rather than after their columns, so the
 * ranking's ORDER BY can only mean the aggregate: Postgres resolves a bare name
 * to the output column in ORDER BY but to the input column in GROUP BY, and a
 * name that is never both cannot be read the wrong way.
 */
function figureColumns(sampledPluginIds: readonly string[]) {
  return {
    total_bytes: sql<number>`sum(${flow.bytes})::float8`.as("total_bytes"),
    total_cost: sql<number>`sum(${flow.estimated_cost})`.as("total_cost"),
    sampled_bytes: sampledSum(flow.bytes, sampledPluginIds).as("sampled_bytes"),
    sampled_cost: sampledSum(flow.estimated_cost, sampledPluginIds).as("sampled_cost"),
    unattributed_bytes: sumWhere(flow.bytes, sql`${flow.attribution} = 'unattributed'`).as(
      "unattributed_bytes",
    ),
    truncated_bytes: sumWhere(flow.bytes, sql`${flow.attribution} = 'truncated'`).as(
      "truncated_bytes",
    ),
  };
}

export interface NetworkFlowReportFigures {
  bytes: number;
  estimated_cost: number;
  sampled_bytes: number;
  sampled_cost: number;
  unattributed_bytes: number;
  truncated_bytes: number;
}

function toFigures(r: {
  total_bytes: unknown;
  total_cost: unknown;
  sampled_bytes: unknown;
  sampled_cost: unknown;
  unattributed_bytes: unknown;
  truncated_bytes: unknown;
}): NetworkFlowReportFigures {
  return {
    bytes: Number(r.total_bytes) || 0,
    estimated_cost: Number(r.total_cost) || 0,
    sampled_bytes: Number(r.sampled_bytes) || 0,
    sampled_cost: Number(r.sampled_cost) || 0,
    unattributed_bytes: Number(r.unattributed_bytes) || 0,
    truncated_bytes: Number(r.truncated_bytes) || 0,
  };
}

function rankOrder(orderByBytes: boolean, bytes = "bytes", cost = "estimated_cost") {
  const b = desc(sql.identifier(bytes));
  const c = desc(sql.identifier(cost));
  return orderByBytes ? [b, c] : [c, b];
}

export interface NetworkFlowReportCellRow extends NetworkFlowReportFigures {
  bucket: string;
  group_key: string;
  currency: string;
}

/**
 * Figures per (bucket, group, currency) over the window. `groupKeys` limits
 * the scan to the groups the chart draws (null = no restriction, used for the
 * ungrouped overall series); an empty list reads nothing.
 */
export async function readNetworkFlowReportCells(
  organizationId: string,
  options: {
    range: NetworkFlowRange;
    bucket: NetworkFlowReportBucket;
    split: NetworkFlowReportSplit;
    filters: NetworkFlowReportSqlFilters;
    sampledPluginIds: readonly string[];
    groupKeys: string[] | null;
  },
): Promise<NetworkFlowReportCellRow[]> {
  if (options.groupKeys && options.groupKeys.length === 0) return [];
  const { key } = splitExpr(options.split);
  const rows = await getAnalyticsDb()
    .select({
      bucket: sql<string>`${bucketOf(options.bucket)}`.as("bucket"),
      group_key: sql<string>`${key}`.as("group_key"),
      currency: flow.currency,
      ...figureColumns(options.sampledPluginIds),
    })
    .from(flow)
    .where(
      and(
        reportWhere(organizationId, options.range, options.filters),
        options.groupKeys ? inArray(key, options.groupKeys) : undefined,
      ),
    )
    .groupBy(sql`bucket`, sql`group_key`, flow.currency)
    .orderBy(asc(sql`bucket`));
  return rows.map((r) => ({
    bucket: r.bucket,
    group_key: r.group_key,
    currency: r.currency,
    ...toFigures(r),
  }));
}

export interface NetworkFlowReportGroupRow extends NetworkFlowReportFigures {
  group_key: string;
  label_a: string;
  label_b: string;
  currency: string;
  pair_count: number;
}

/**
 * Per-group totals over the window, largest first (by money, or by bytes for a
 * bytes-only report), at most `limit`; plus how many groups there were in all,
 * counted before the limit by a window function so the table can say what it
 * left out.
 */
export async function readNetworkFlowReportGroups(
  organizationId: string,
  options: {
    range: NetworkFlowRange;
    split: NetworkFlowReportSplit;
    filters: NetworkFlowReportSqlFilters;
    sampledPluginIds: readonly string[];
    orderByBytes: boolean;
    limit: number;
  },
): Promise<{ rows: NetworkFlowReportGroupRow[]; count: number }> {
  const { key, labelA, labelB } = splitExpr(options.split);
  const rows = await getAnalyticsDb()
    .select({
      group_key: sql<string>`${key}`.as("group_key"),
      label_a: sql<string>`${labelA}`.as("label_a"),
      label_b: sql<string>`${labelB}`.as("label_b"),
      currency: flow.currency,
      ...figureColumns(options.sampledPluginIds),
      pair_count: sql<string>`count(DISTINCT ${flow.pair_hash})`.as("pair_count"),
      group_count: sql<string>`count(*) OVER ()`.as("group_count"),
    })
    .from(flow)
    .where(reportWhere(organizationId, options.range, options.filters))
    .groupBy(sql`group_key`, flow.currency)
    .orderBy(...rankOrder(options.orderByBytes, "total_bytes", "total_cost"), asc(sql`group_key`))
    .limit(Math.max(1, Math.min(500, Math.floor(options.limit))));
  return {
    rows: rows.map((r) => ({
      group_key: r.group_key,
      label_a: r.label_a,
      label_b: r.label_b,
      currency: r.currency,
      pair_count: Number(r.pair_count) || 0,
      ...toFigures(r),
    })),
    count: rows.length > 0 ? Number(rows[0]!.group_count) || rows.length : 0,
  };
}

export interface NetworkFlowReportTalkerRow extends NetworkFlowPair {
  src_network: string;
  dst_network: string;
  sampled: number;
}

/**
 * The largest flow pairs under a report's filters. Truncation rows are not a
 * pair and are left out; unattributed pairs stay in, as on the feed.
 */
export async function readNetworkFlowReportTalkers(
  organizationId: string,
  options: {
    range: NetworkFlowRange;
    filters: NetworkFlowReportSqlFilters;
    sampledPluginIds: readonly string[];
    orderByBytes: boolean;
    limit: number;
  },
): Promise<NetworkFlowReportTalkerRow[]> {
  const sampled =
    options.sampledPluginIds.length > 0
      ? sql<number>`max(CASE WHEN ${inArray(flow.plugin_id, [...options.sampledPluginIds])} THEN 1 ELSE 0 END)`
      : sql<number>`0`;
  const rows = await getAnalyticsDb()
    .select({
      src_ref: anyValue(flow.src_ref).as("src_ref"),
      src_label: anyValue(flow.src_label).as("src_label"),
      src_zone: anyValue(flow.src_zone).as("src_zone"),
      src_region: anyValue(flow.src_region).as("src_region"),
      src_service: anyValue(flow.src_service).as("src_service"),
      src_resource_type_id: anyValue(flow.src_resource_type_id).as("src_resource_type_id"),
      src_network: anyValue(flow.src_network).as("src_network"),
      dst_ref: anyValue(flow.dst_ref).as("dst_ref"),
      dst_label: anyValue(flow.dst_label).as("dst_label"),
      dst_zone: anyValue(flow.dst_zone).as("dst_zone"),
      dst_region: anyValue(flow.dst_region).as("dst_region"),
      dst_service: anyValue(flow.dst_service).as("dst_service"),
      dst_resource_type_id: anyValue(flow.dst_resource_type_id).as("dst_resource_type_id"),
      dst_network: anyValue(flow.dst_network).as("dst_network"),
      scope: flow.scope,
      direction: flow.direction,
      attribution: anyValue(flow.attribution).as("attribution"),
      bytes: sql<string>`sum(${flow.bytes})`.as("bytes"),
      packets: sql<string>`sum(${flow.packets})`.as("packets"),
      estimated_cost: sql<number>`sum(${flow.estimated_cost})`.as("estimated_cost"),
      currency: anyValue(flow.currency).as("currency"),
      account_id: anyValue(flow.account_id).as("account_id"),
      plugin_id: anyValue(flow.plugin_id).as("plugin_id"),
      days: sql<string>`count(DISTINCT ${flow.day})`.as("days"),
      sampled: sampled.as("sampled"),
    })
    .from(flow)
    .where(
      and(
        reportWhere(organizationId, options.range, options.filters),
        sql`${flow.attribution} != 'truncated'`,
      ),
    )
    .groupBy(flow.scope, flow.direction, flow.pair_hash)
    .orderBy(...rankOrder(options.orderByBytes))
    .limit(Math.max(1, Math.min(500, Math.floor(options.limit))));
  return rows.map((r) => ({
    ...r,
    bytes: Number(r.bytes),
    packets: Number(r.packets),
    estimated_cost: Number(r.estimated_cost),
    days: Number(r.days),
    sampled: Number(r.sampled) || 0,
  }));
}

export interface NetworkFlowReportDimensionValues {
  networks: string[];
  regions: string[];
  zones: string[];
  services: string[];
  resourceTypes: string[];
  scopes: string[];
  endpoints: Array<{
    ref: string;
    label: string;
    resource_type_id: string;
    side: "source" | "destination" | "both";
  }>;
}

/** Distinct values per picker, capped so a busy estate stays a picker. */
const OPTION_VALUES_CAP = 500;

/**
 * Picker values for the report editor: every network, region, zone, peer
 * service, peer resource type and boundary in the window, and the heaviest
 * endpoints on either side. Under the same org predicate as a run, so a
 * scoped caller is offered only values from accounts they may see.
 */
export async function readNetworkFlowReportDimensionValues(
  organizationId: string,
  range: NetworkFlowRange,
  excludePluginIds: string[] = [],
): Promise<NetworkFlowReportDimensionValues> {
  const where = reportWhere(organizationId, range, { excludePluginIds });
  const db = getAnalyticsDb();
  // `array_agg(DISTINCT …)` sorts, so a capped picker keeps the first values
  // alphabetically rather than an arbitrary subset. Over no rows it is NULL.
  const capped = (column: SQLWrapper) =>
    sql`(array_agg(DISTINCT ${column}))[1:${sql.raw(String(OPTION_VALUES_CAP))}]`;
  const both = (a: SQLWrapper, b: SQLWrapper) => sql<string[] | null>`${capped(a)} || ${capped(b)}`;
  // Each row is read twice, once per end, so an endpoint is ranked by all the
  // traffic it took part in; `side` is a bit (1 source, 2 destination) that
  // `bit_or` folds into "which ends was it seen at".
  const endpoint = sql`(VALUES
    (${flow.src_ref}, ${flow.src_label}, ${flow.src_resource_type_id}, 1),
    (${flow.dst_ref}, ${flow.dst_label}, ${flow.dst_resource_type_id}, 2)
  ) AS endpoint(ref, label, resource_type_id, side)`;
  const [dims, endpoints] = await Promise.all([
    db
      .select({
        networks: both(flow.src_network, flow.dst_network).as("networks"),
        regions: both(flow.src_region, flow.dst_region).as("regions"),
        zones: both(flow.src_zone, flow.dst_zone).as("zones"),
        services: sql<string[] | null>`${capped(peerService)}`.as("services"),
        resource_types: sql<string[] | null>`${capped(peerResourceType)}`.as("resource_types"),
        scopes: sql<string[] | null>`array_agg(DISTINCT ${flow.scope})`.as("scopes"),
      })
      .from(flow)
      .where(where),
    db
      .select({
        ref: sql<string>`endpoint.ref`.as("ref"),
        label: sql<string>`max(endpoint.label)`.as("label"),
        resource_type_id: sql<string>`max(endpoint.resource_type_id)`.as("resource_type_id"),
        sides: sql<number>`bit_or(endpoint.side)`.as("sides"),
        bytes: sql<number>`sum(${flow.bytes})::float8`.as("bytes"),
      })
      .from(flow)
      .crossJoinLateral(endpoint)
      .where(and(where, sql`${flow.attribution} != 'truncated'`))
      .groupBy(sql`endpoint.ref`)
      .orderBy(desc(sql`bytes`))
      .limit(OPTION_VALUES_CAP),
  ]);
  const row = dims[0];
  const distinct = (values: string[] | null | undefined) =>
    [...new Set((values ?? []).filter((v) => v !== ""))].sort((a, b) => a.localeCompare(b));
  return {
    networks: distinct(row?.networks),
    regions: distinct(row?.regions),
    zones: distinct(row?.zones),
    services: distinct(row?.services),
    resourceTypes: distinct(row?.resource_types),
    scopes: distinct(row?.scopes),
    endpoints: endpoints
      .filter((e) => e.ref !== "")
      .map((e) => {
        const sides = Number(e.sides) || 0;
        const side: "source" | "destination" | "both" =
          sides === 3 ? "both" : sides === 2 ? "destination" : "source";
        return { ref: e.ref, label: e.label || e.ref, resource_type_id: e.resource_type_id, side };
      }),
  };
}
