/**
 * The cloud {@link GraphHost}: what a custom-graph script's powers actually do
 * on the web server. Everything is org-scoped at the source — cost queries go
 * through the same `runCostQuery` the dashboards use, resource listings and
 * metric lookups resolve rows by `organization_id`, and the key/value store
 * filters on both org and graph id. `fetch` leaves through the workflow
 * egress proxy, never from the pod.
 */
import { and, asc, count, eq, ilike, isNull, sql } from "drizzle-orm";

import { getMetricRange } from "@infrawrench/server-core/clickhouse/readers";
import { buildWorkflowFetch } from "@infrawrench/server-core/workflows/fetch";
import type {
  GraphCostQuery,
  GraphCostResult,
  GraphHost,
  GraphMetricSeries,
  GraphResourceFilter,
  GraphResourceInfo,
} from "@infrawrench/workflow-runtime";

import { db } from "../db/client";
import { accounts, customGraphData, resources } from "../db/schema";
import { runCostQuery } from "./cost-query";
import { getClientForResource } from "./plugin-clients";

/** Rows a `graph.resources.list()` call returns at most. */
const MAX_RESOURCE_ROWS = 500;

/** Keys one graph may store — the data store is state, not a database. */
const MAX_DATA_KEYS = 200;

async function listOrgResources(
  organizationId: string,
  filter: GraphResourceFilter,
): Promise<GraphResourceInfo[]> {
  const conditions = [
    eq(resources.organizationId, organizationId),
    isNull(resources.deletedAt),
    ...(filter.pluginId ? [eq(resources.pluginId, filter.pluginId)] : []),
    ...(filter.resourceTypeId ? [eq(resources.resourceTypeId, filter.resourceTypeId)] : []),
    ...(filter.accountId ? [eq(resources.accountId, filter.accountId)] : []),
    ...(filter.search
      ? [ilike(resources.displayName, `%${filter.search.replaceAll(/[%_\\]/g, "\\$&")}%`)]
      : []),
  ];
  const rows = await db
    .select({
      id: resources.id,
      displayName: resources.displayName,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      accountName: accounts.displayName,
    })
    .from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(and(...conditions))
    .orderBy(asc(resources.displayName))
    .limit(MAX_RESOURCE_ROWS);
  return rows.map((r) => ({ ...r, accountName: r.accountName ?? r.accountId }));
}

/**
 * Metric lookup mirrors the resource-detail route: ClickHouse history first
 * (only pinned resources accumulate points), then a live provider fetch. The
 * live path's failure degrades to "no data" — a dead provider must not fail
 * the whole render.
 */
async function metricSeriesForResource(
  organizationId: string,
  resourceId: string,
  range: { startMs: number; endMs: number },
): Promise<GraphMetricSeries[]> {
  const [row] = await db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      accountId: resources.accountId,
      parentResourceId: resources.parentResourceId,
    })
    .from(resources)
    .where(
      and(
        eq(resources.id, resourceId),
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`Resource not found: ${resourceId}`);

  const history = await getMetricRange(organizationId, row.id, range.startMs, range.endMs);
  if (history.length > 0) return history;

  try {
    const ctx = await getClientForResource(
      row.pluginId,
      row.accountId,
      organizationId,
      row.parentResourceId ?? undefined,
    );
    if (!ctx?.client.fetchMetricSeries) return [];
    const live = await ctx.client.fetchMetricSeries(row.resourceTypeId, row.id, row.accountId, {
      startMs: range.startMs,
      endMs: range.endMs,
    });
    return (live ?? []).map((s) => ({
      label: s.label,
      ...(s.unit !== undefined ? { unit: s.unit } : {}),
      points: (s.points ?? []).map((p) => ({ timestamp: p.timestamp, value: p.value })),
    }));
  } catch {
    return [];
  }
}

async function queryOrgCosts(
  organizationId: string,
  query: GraphCostQuery,
): Promise<GraphCostResult> {
  const response = await runCostQuery(organizationId, {
    from: query.from,
    to: query.to,
    binning: query.binning,
    groupBy: query.groupBy,
    ...(query.groupByTagKey ? { groupByTagKey: query.groupByTagKey } : {}),
    filters: query.filters,
    topN: query.topN,
    comparePreviousPeriod: false,
    forecast: false,
  });
  // With mixed currencies the same group can appear once per currency; the
  // suffix keeps series keys unique so a straight pass-through still renders.
  const mixed = response.currencies.length > 1;
  return {
    series: response.series.map((s) => ({
      key: (s.key || s.label || "total") + (mixed ? ` (${s.currency})` : ""),
      label: (s.label || s.key || "Total") + (mixed ? ` (${s.currency})` : ""),
      currency: s.currency,
      points: s.points.map((p) => ({ x: p.bucket, y: p.amount })),
    })),
    totals: response.totals,
    currencies: response.currencies,
  };
}

export function buildOrgCustomGraphHost(organizationId: string, graphId: string): GraphHost {
  const scope = and(
    eq(customGraphData.organizationId, organizationId),
    eq(customGraphData.graphId, graphId),
  );
  return {
    queryCosts: (query) => queryOrgCosts(organizationId, query),
    listResources: (filter) => listOrgResources(organizationId, filter),
    metricSeries: (resourceId, range) => metricSeriesForResource(organizationId, resourceId, range),

    dataGet: async (key) => {
      const [row] = await db
        .select({ value: customGraphData.value })
        .from(customGraphData)
        .where(and(scope, eq(customGraphData.key, key)))
        .limit(1);
      return row ? row.value : null;
    },
    dataSet: async (key, value) => {
      // Stored as an explicit jsonb parameter: drizzle binds a JS null as SQL
      // NULL (bypassing the jsonb encoder), which would violate the column's
      // NOT NULL — and `graph.data.set(key, null)` is a legitimate write.
      const jsonValue = sql`${JSON.stringify(value ?? null)}::jsonb`;
      const [existing] = await db
        .select({ id: customGraphData.id })
        .from(customGraphData)
        .where(and(scope, eq(customGraphData.key, key)))
        .limit(1);
      if (existing) {
        await db
          .update(customGraphData)
          .set({ value: jsonValue, updatedAt: new Date() })
          .where(eq(customGraphData.id, existing.id));
        return;
      }
      const counted = await db.select({ keys: count() }).from(customGraphData).where(scope);
      if ((counted[0]?.keys ?? 0) >= MAX_DATA_KEYS) {
        throw new Error(`graph.data: a graph may store at most ${MAX_DATA_KEYS} keys.`);
      }
      await db.insert(customGraphData).values({
        id: crypto.randomUUID(),
        organizationId,
        graphId,
        key,
        value: jsonValue,
      });
    },
    dataDelete: async (key) => {
      await db.delete(customGraphData).where(and(scope, eq(customGraphData.key, key)));
    },
    dataList: async () => {
      const rows = await db
        .select({ key: customGraphData.key })
        .from(customGraphData)
        .where(scope)
        .orderBy(asc(customGraphData.key));
      return rows.map((r) => r.key);
    },

    fetch: buildWorkflowFetch(),
  };
}
