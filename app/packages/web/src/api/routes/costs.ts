import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import {
  costQueryRequestSchema,
  OTHER_GROUP_KEY,
  type CostQueryRequest,
  type CostQueryResponse,
  type CostQuerySeries,
  type CostSeriesPoint,
} from "@infrawrench/ui/cost/config";
import {
  getCostCoverage,
  getCostDimensionValues,
  getCostTagKeys,
  queryCosts,
  type CostSeriesGroup,
} from "@infrawrench/server-core/clickhouse/cost-readers";
import { forecastDaily } from "@infrawrench/server-core/cost/forecast";
import { db } from "../../db/client";
import { accounts } from "../../db/schema";
import { getPlugin, loadPlugins } from "../../plugins/loader";
import type { AuthSession } from "../auth-middleware";
import { requirePermission } from "../../auth/permissions";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDay(d);
}

function daySpan(from: string, to: string): number {
  return (
    Math.round(
      (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) /
        86_400_000,
    ) + 1
  );
}

/**
 * Fold groups beyond the top N (ranked by period total, per currency) into a
 * single "Other" series so charts stay legible
 */
function foldTopN(groups: CostSeriesGroup[], topN: number): CostSeriesGroup[] {
  const byCurrency = new Map<string, CostSeriesGroup[]>();
  for (const g of groups) {
    const list = byCurrency.get(g.currency) ?? [];
    list.push(g);
    byCurrency.set(g.currency, list);
  }

  const result: CostSeriesGroup[] = [];
  for (const [currency, list] of byCurrency) {
    const ranked = [...list].sort(
      (a, b) =>
        b.points.reduce((s, p) => s + p.amount, 0) - a.points.reduce((s, p) => s + p.amount, 0),
    );
    result.push(...ranked.slice(0, topN));
    const rest = ranked.slice(topN);
    if (rest.length > 0) {
      const folded = new Map<string, number>();
      for (const g of rest) {
        for (const p of g.points) folded.set(p.bucket, (folded.get(p.bucket) ?? 0) + p.amount);
      }
      result.push({
        key: OTHER_GROUP_KEY,
        currency,
        points: [...folded.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([bucket, amount]) => ({ bucket, amount })),
      });
    }
  }
  return result;
}

/** Resolve display labels for group keys (providers → plugin names, accounts → display names). */
async function labelSeries(
  organizationId: string,
  groupBy: CostQueryRequest["groupBy"],
  groups: CostSeriesGroup[],
): Promise<CostQuerySeries[]> {
  let labelFor = (key: string): string => key || "Total";
  if (groupBy === "provider") {
    const loaded = await loadPlugins();
    const names = new Map(loaded.map((l) => [l.plugin.manifest.id, l.plugin.manifest.displayName]));
    labelFor = (key) => names.get(key) ?? key;
  } else if (groupBy === "account") {
    const rows = await db
      .select({ id: accounts.id, displayName: accounts.displayName })
      .from(accounts)
      .where(eq(accounts.organizationId, organizationId));
    const names = new Map(rows.map((r) => [r.id, r.displayName]));
    labelFor = (key) => names.get(key) ?? key;
  }
  return groups.map((g) => ({
    key: g.key,
    label: g.key === OTHER_GROUP_KEY ? "Other" : labelFor(g.key),
    currency: g.currency,
    points: g.points,
  }));
}

function totalsOf(groups: CostSeriesGroup[], binning: CostQueryRequest["binning"]) {
  const totals: Record<string, number> = {};
  for (const g of groups) {
    // Cumulative points are running sums — the period total is the last point.
    const sum =
      binning === "cumulative"
        ? (g.points[g.points.length - 1]?.amount ?? 0)
        : g.points.reduce((s, p) => s + p.amount, 0);
    totals[g.currency] = (totals[g.currency] ?? 0) + sum;
  }
  return totals;
}

/** POST /api/org/:orgId/costs/query — aggregate cost series for a graph. */
app.post("/query", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");

  const parsed = costQueryRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid query", issues: parsed.error.issues }, 400);
  }
  const q = parsed.data;
  if (q.groupBy === "tag" && !q.groupByTagKey) {
    return c.json({ error: "groupByTagKey is required when groupBy is tag" }, 400);
  }
  if (q.from > q.to) return c.json({ error: "from must not be after to" }, 400);
  if (daySpan(q.from, q.to) > 1100) return c.json({ error: "Date range too large" }, 400);

  const baseQuery = {
    from: q.from,
    to: q.to,
    binning: q.binning,
    groupBy: q.groupBy,
    filters: q.filters,
    ...(q.groupByTagKey ? { groupByTagKey: q.groupByTagKey } : {}),
  };

  const grouped = foldTopN(await queryCosts(organizationId, baseQuery), q.topN);
  const series = await labelSeries(organizationId, q.groupBy, grouped);

  const response: CostQueryResponse = {
    series,
    currencies: [...new Set(grouped.map((g) => g.currency))].sort(),
    totals: totalsOf(grouped, q.binning),
  };

  if (q.comparePreviousPeriod) {
    const span = daySpan(q.from, q.to);
    const prevGrouped = foldTopN(
      await queryCosts(organizationId, {
        ...baseQuery,
        from: addDays(q.from, -span),
        to: addDays(q.to, -span),
      }),
      q.topN,
    );
    response.comparison = await labelSeries(organizationId, q.groupBy, prevGrouped);
    response.previousTotals = totalsOf(prevGrouped, q.binning);
  }

  if (q.forecast) {
    // Fit on trailing daily totals (ungrouped) ending at the range end, then
    // project past the last observed day: to the range end when the range
    // extends beyond the data, otherwise ~a quarter of the range ahead.
    const fitGroups = await queryCosts(organizationId, {
      from: addDays(q.to, -59),
      to: q.to,
      binning: "daily",
      groupBy: "none",
      filters: q.filters,
    });
    const dailyTotals = new Map<string, number>();
    for (const g of fitGroups) {
      for (const p of g.points)
        dailyTotals.set(p.bucket, (dailyTotals.get(p.bucket) ?? 0) + p.amount);
    }
    const observed = [...dailyTotals.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, amount]) => ({ day, amount }));
    const lastObserved = observed[observed.length - 1]?.day;
    if (lastObserved) {
      const toEnd = daySpan(lastObserved, q.to) - 1;
      const horizon =
        toEnd > 0 ? toEnd : Math.min(30, Math.max(3, Math.ceil(daySpan(q.from, q.to) / 4)));
      const projected: CostSeriesPoint[] = forecastDaily(observed, horizon).map((p) => ({
        bucket: p.day,
        amount: p.amount,
      }));
      if (projected.length > 0) response.forecast = projected;
    }
  }

  return c.json(response);
});

/** GET /api/org/:orgId/costs/dimensions?dimension=service|region|...&tagKey= */
app.get("/dimensions", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");
  const dimension = c.req.query("dimension");

  if (dimension === "tag-keys") {
    return c.json({ values: await getCostTagKeys(organizationId) });
  }
  if (
    dimension !== "provider" &&
    dimension !== "account" &&
    dimension !== "service" &&
    dimension !== "region" &&
    dimension !== "resource" &&
    dimension !== "tag"
  ) {
    return c.json({ error: "Invalid dimension" }, 400);
  }
  if (dimension === "tag" && !c.req.query("tagKey")) {
    return c.json({ error: "tagKey is required for the tag dimension" }, 400);
  }

  const tagKey = c.req.query("tagKey");
  const values = await getCostDimensionValues(organizationId, dimension, {
    ...(tagKey ? { tagKey } : {}),
  });

  // Attach display labels where the raw value is an internal id.
  if (dimension === "provider") {
    const loaded = await loadPlugins();
    const names = new Map(loaded.map((l) => [l.plugin.manifest.id, l.plugin.manifest.displayName]));
    return c.json({ values: values.map((v) => ({ value: v, label: names.get(v) ?? v })) });
  }
  if (dimension === "account") {
    const rows = await db
      .select({ id: accounts.id, displayName: accounts.displayName })
      .from(accounts)
      .where(eq(accounts.organizationId, organizationId));
    const names = new Map(rows.map((r) => [r.id, r.displayName]));
    return c.json({ values: values.map((v) => ({ value: v, label: names.get(v) ?? v })) });
  }
  return c.json({ values: values.map((v) => ({ value: v, label: v })) });
});

/**
 * GET /api/org/:orgId/costs/status — per-account cost capability + collection
 * state. Drives "Backfilling AWS history…" empty states and the config UI.
 */
app.get("/status", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");

  const rows = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      displayName: accounts.displayName,
      costLastPolledAt: accounts.costLastPolledAt,
      costBackfilledAt: accounts.costBackfilledAt,
      costPollFailureCount: accounts.costPollFailureCount,
    })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));

  const coverage = await getCostCoverage(organizationId);

  const result = await Promise.all(
    rows.map(async (row) => {
      const loaded = await getPlugin(row.pluginId);
      const capability = loaded?.plugin.manifest.costs ?? null;
      return {
        accountId: row.id,
        pluginId: row.pluginId,
        displayName: row.displayName,
        supportsCosts: !!capability,
        periodNative: capability?.periodNative ?? false,
        dimensions: capability?.dimensions ?? [],
        costLastPolledAt: row.costLastPolledAt?.toISOString() ?? null,
        costBackfilledAt: row.costBackfilledAt?.toISOString() ?? null,
        costPollFailureCount: row.costPollFailureCount,
        coverage: coverage.get(row.id) ?? null,
      };
    }),
  );

  return c.json({ accounts: result });
});

export { app as costRoutes };
