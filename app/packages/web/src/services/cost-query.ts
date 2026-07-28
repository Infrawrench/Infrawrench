/**
 * Org-scoped cost query execution — shared by the HTTP routes
 * (api/routes/costs.ts) and the tool registry (tools/costs.ts) so the graph
 * API and the MCP/chat surface stay behaviourally identical.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  OTHER_GROUP_KEY,
  type CostAccountStatus,
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
import { addDays, isoDay } from "@infrawrench/server-core/cost/dates";
// The db-free id module, not the writer — importing the writer here would drag
// its db/ClickHouse imports into every cost read path (and its tests).
import {
  WORKFLOW_COST_PLUGIN_ID,
  workflowIdFromCostAccountId,
} from "@infrawrench/server-core/cost/workflow-cost-ids";
import {
  DEPLOYMENT_COST_PLUGIN_ID,
  DEPLOYMENT_COST_PROVIDER_LABEL,
  deploymentCostAccountLabels,
} from "@infrawrench/server-core/cost/deployment-cost-ids";
import {
  EXTERNAL_COST_PLUGIN_ID,
  sourceFromCostAccountId,
} from "@infrawrench/server-core/cost/external-cost-ids";
import { db } from "../db/client";
import { accounts, workflows } from "../db/schema";
import { getPlugin, loadPlugins } from "../plugins/loader";

/** Invalid caller input — routes map this to a 400, tools to an error result. */
export class CostQueryError extends Error {}

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

/**
 * Plugin id → display name, plus the two synthetic providers that have no
 * plugin behind them: rows a workflow reported (`cost/workflow-costs`) and rows
 * a server pushed over the API (`cost/external-costs`).
 */
async function providerNames(): Promise<Map<string, string>> {
  const loaded = await loadPlugins();
  const names = new Map(loaded.map((l) => [l.plugin.manifest.id, l.plugin.manifest.displayName]));
  names.set(WORKFLOW_COST_PLUGIN_ID, "Workflow");
  names.set(EXTERNAL_COST_PLUGIN_ID, "External");
  names.set(DEPLOYMENT_COST_PLUGIN_ID, DEPLOYMENT_COST_PROVIDER_LABEL);
  return names;
}

/** Resolve display labels for group keys (providers → plugin names, accounts → display names). */
async function labelSeries(
  organizationId: string,
  groupBy: CostQueryRequest["groupBy"],
  groups: CostSeriesGroup[],
): Promise<CostQuerySeries[]> {
  let labelFor = (key: string): string => key || "Total";
  if (groupBy === "provider") {
    const names = await providerNames();
    labelFor = (key) => names.get(key) ?? key;
  } else if (groupBy === "account") {
    const rows = await db
      .select({ id: accounts.id, displayName: accounts.displayName })
      .from(accounts)
      .where(eq(accounts.organizationId, organizationId));
    const names = new Map(rows.map((r) => [r.id, r.displayName]));
    for (const [id, name] of await workflowCostAccountLabels(
      organizationId,
      groups.map((g) => g.key),
    )) {
      names.set(id, name);
    }
    for (const [id, name] of externalCostAccountLabels(groups.map((g) => g.key))) {
      names.set(id, name);
    }
    for (const [id, name] of deploymentCostAccountLabels(groups.map((g) => g.key))) {
      names.set(id, name);
    }
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

/** Aggregate cost series for a graph, plus optional comparison and forecast. */
export async function runCostQuery(
  organizationId: string,
  q: CostQueryRequest,
): Promise<CostQueryResponse> {
  if (q.groupBy === "tag" && !q.groupByTagKey) {
    throw new CostQueryError("groupByTagKey is required when groupBy is tag");
  }
  if (q.from > q.to) throw new CostQueryError("from must not be after to");
  if (daySpan(q.from, q.to) > 1100) throw new CostQueryError("Date range too large");

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

  return response;
}

export interface CostDimensionValue {
  value: string;
  label: string;
}

/** Distinct tag keys seen in the org's cost data. */
export async function listCostTagKeys(organizationId: string): Promise<string[]> {
  return getCostTagKeys(organizationId);
}

/**
 * Distinct values seen in cost data for a dimension, with display labels
 * resolved for internal ids.
 */
export async function listCostDimensionValues(
  organizationId: string,
  dimension: string,
  tagKey?: string,
): Promise<CostDimensionValue[]> {
  if (
    dimension !== "provider" &&
    dimension !== "account" &&
    dimension !== "service" &&
    dimension !== "region" &&
    dimension !== "resource" &&
    dimension !== "tag"
  ) {
    throw new CostQueryError("Invalid dimension");
  }
  if (dimension === "tag" && !tagKey) {
    throw new CostQueryError("tagKey is required for the tag dimension");
  }

  const values = await getCostDimensionValues(organizationId, dimension, {
    ...(tagKey ? { tagKey } : {}),
  });

  // Attach display labels where the raw value is an internal id.
  if (dimension === "provider") {
    const names = await providerNames();
    return values.map((v) => ({ value: v, label: names.get(v) ?? v }));
  }
  if (dimension === "account") {
    const rows = await db
      .select({ id: accounts.id, displayName: accounts.displayName })
      .from(accounts)
      .where(eq(accounts.organizationId, organizationId));
    const names = new Map(rows.map((r) => [r.id, r.displayName]));
    for (const [id, name] of await workflowCostAccountLabels(organizationId, values)) {
      names.set(id, name);
    }
    for (const [id, name] of externalCostAccountLabels(values)) {
      names.set(id, name);
    }
    for (const [id, name] of deploymentCostAccountLabels(values)) {
      names.set(id, name);
    }
    return values.map((v) => ({ value: v, label: names.get(v) ?? v }));
  }
  return values.map((v) => ({ value: v, label: v }));
}

/**
 * Labels for the synthetic `workflow:<id>` cost accounts a workflow writes to
 * when it doesn't attribute its rows to a real account. Without this the
 * account picker shows an opaque uuid.
 */
async function workflowCostAccountLabels(
  organizationId: string,
  values: string[],
): Promise<Map<string, string>> {
  const byAccountId = new Map<string, string>();
  const workflowIds = new Map<string, string>();
  for (const value of values) {
    const workflowId = workflowIdFromCostAccountId(value);
    if (workflowId) workflowIds.set(workflowId, value);
  }
  if (workflowIds.size === 0) return byAccountId;

  const rows = await db
    .select({ id: workflows.id, name: workflows.name })
    .from(workflows)
    .where(
      and(
        eq(workflows.organizationId, organizationId),
        inArray(workflows.id, [...workflowIds.keys()]),
      ),
    );
  for (const row of rows) {
    const accountId = workflowIds.get(row.id);
    // Deleted workflows keep their rows (spend history outlives the script), so
    // fall back to the raw value rather than dropping the series.
    if (accountId) byAccountId.set(accountId, `${row.name} (workflow)`);
  }
  return byAccountId;
}

/**
 * Labels for the synthetic `external:<source>` cost accounts a server writes to
 * when it pushes rows without naming a real account. Unlike workflows there is
 * no row to look up — the source name IS the label — so this is purely local.
 */
function externalCostAccountLabels(values: string[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const value of values) {
    const source = sourceFromCostAccountId(value);
    if (source) labels.set(value, `${source} (external)`);
  }
  return labels;
}

/**
 * Per-account cost capability + collection state. Drives "Backfilling AWS
 * history…" empty states, the config UI, and the get_cost_status tool.
 *
 * Annotated with the client-side contract so this producer — not just its
 * three consumers (web, mobile, the `infrawrench costs` CLI) — is checked
 * against `CostAccountStatus`.
 */
export async function getOrgCostStatus(organizationId: string): Promise<CostAccountStatus[]> {
  const rows = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      displayName: accounts.displayName,
      costLastPolledAt: accounts.costLastPolledAt,
      costBackfilledAt: accounts.costBackfilledAt,
      costPollFailureCount: accounts.costPollFailureCount,
      costPollError: accounts.costPollError,
      costPollErrorHelpLabel: accounts.costPollErrorHelpLabel,
      costPollErrorHelpUrl: accounts.costPollErrorHelpUrl,
    })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));

  const coverage = await getCostCoverage(organizationId);

  return Promise.all(
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
        // Last failure, so an empty graph can explain itself. `helpLink` is
        // set when the plugin knows which provider page fixes it.
        costPollError: row.costPollError
          ? {
              message: row.costPollError,
              helpLink:
                row.costPollErrorHelpUrl && row.costPollErrorHelpLabel
                  ? { label: row.costPollErrorHelpLabel, url: row.costPollErrorHelpUrl }
                  : null,
            }
          : null,
        coverage: coverage.get(row.id) ?? null,
      };
    }),
  );
}
