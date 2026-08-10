/**
 * Org-scoped cost query execution — shared by the HTTP routes
 * (api/routes/costs.ts) and the tool registry (tools/costs.ts) so the graph
 * API and the MCP/chat surface stay behaviourally identical.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  COST_CHARGE_TYPES,
  COST_CHARGE_TYPE_LABELS,
  COST_DIMENSIONS,
  CostQueryParseError,
  OTHER_GROUP_KEY,
  parseCostQuery,
  type CostAccountStatus,
  type CostDimensionId,
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
import {
  convertGroups,
  mergeConvertedGroups,
} from "@infrawrench/server-core/cost/currency-convert";
import { loadConversionContext } from "@infrawrench/server-core/cost/currency-settings";
import {
  SavedCostFilterResolutionError,
  resolveSavedCostFilters,
} from "@infrawrench/server-core/cost/saved-filters";
import { resolveBillingAdjustments } from "@infrawrench/server-core/cost/billing-rules";
import {
  billingAdjustmentsAreEmpty,
  fixedTotalsForRange,
  type CompiledBillingAdjustments,
  type CostAdjustmentSummary,
} from "@infrawrench/client-core";
// The scenario overlay lives in its own module rather than growing this
// function: everything it needs is already computed by the time it runs.
import { CostScenarioError, attachCostScenario } from "./cost-scenario-query";
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

/**
 * Where a text cost query went wrong, in a shape a client can render.
 *
 * Offsets are into the query string the caller sent, so a UI can underline the
 * span and a terminal can put a caret under it without re-deriving anything.
 */
export interface CostQueryTextError {
  /** Zero-based character offset into the submitted `query`. */
  offset: number;
  length: number;
  /** Valid alternatives at that offset — the dimension names, the operators. */
  expected: string[];
}

/** Invalid caller input — routes map this to a 400, tools to an error result. */
export class CostQueryError extends Error {
  /**
   * Set only for a cost-query-language parse failure. Optional so every
   * existing `new CostQueryError(message)` keeps meaning what it meant, and so
   * a caller that does not understand the field still gets a usable message.
   */
  readonly queryError?: CostQueryTextError;

  constructor(message: string, queryError?: CostQueryTextError) {
    super(message);
    if (queryError) this.queryError = queryError;
  }
}

/**
 * The filters a request actually runs: its structured `filters`, or its `query`
 * compiled into exactly that shape.
 *
 * The two are alternatives, never a merge and never a precedence rule. A caller
 * that sends both has expressed two different intentions and there is no
 * reading of "which one wins" that is not a silent wrong answer — so it is an
 * error. An empty `filters` alongside a query is fine: it is what every client
 * built on `CostQueryRequest` sends, because the field is required and `[]` is
 * the absence of a filter rather than a filter.
 *
 * Compiling here rather than in the HTTP route is what keeps the MCP tool and
 * the API behaviourally identical — both go through `runCostQuery`.
 */
function resolveQueryFilters(q: CostQueryRequest): CostQueryRequest["filters"] {
  const text = q.query?.trim();
  if (!text) return q.filters;
  if (q.filters.length > 0) {
    throw new CostQueryError(
      "Send either `filters` or `query`, not both — they are two spellings of the same filter, " +
        "and running one while ignoring the other would silently answer a different question.",
    );
  }
  try {
    return parseCostQuery(text);
  } catch (e) {
    if (e instanceof CostQueryParseError) {
      throw new CostQueryError(`Invalid query at offset ${e.offset}: ${e.message}`, {
        offset: e.offset,
        length: e.length,
        expected: [...e.expected],
      });
    }
    throw e;
  }
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
      // Folded alongside `points`, not dropped: `rawTotals` is the sum of every
      // group's collected figure, so an "Other" that lost its raw half would
      // understate collected spend by exactly the tail the chart hid.
      const foldedRaw = new Map<string, number>();
      let anyRaw = false;
      for (const g of rest) {
        for (const p of g.points) folded.set(p.bucket, (folded.get(p.bucket) ?? 0) + p.amount);
        if (g.rawPoints) {
          anyRaw = true;
          for (const p of g.rawPoints) {
            foldedRaw.set(p.bucket, (foldedRaw.get(p.bucket) ?? 0) + p.amount);
          }
        }
      }
      const toPoints = (m: Map<string, number>) =>
        [...m.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([bucket, amount]) => ({ bucket, amount }));
      result.push({
        key: OTHER_GROUP_KEY,
        currency,
        points: toPoints(folded),
        ...(anyRaw ? { rawPoints: toPoints(foldedRaw) } : {}),
      });
    }
  }
  return result;
}

/**
 * Per-currency totals of the *collected* amounts a set of groups carries.
 *
 * Summed over every point rather than read off the last one the way
 * {@link totalsOf} does for cumulative binning: `rawPoints` is a partition of
 * the collected money by adjusted group, and the only thing it is ever read as
 * is its sum. Doing the cumulative special-case here too would be correct but
 * would imply a per-series reading the wire shape deliberately refuses.
 */
function rawTotalsOf(
  groups: CostSeriesGroup[],
  binning: CostQueryRequest["binning"],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const g of groups) {
    if (!g.rawPoints) continue;
    const sum =
      binning === "cumulative"
        ? (g.rawPoints[g.rawPoints.length - 1]?.amount ?? 0)
        : g.rawPoints.reduce((s, p) => s + p.amount, 0);
    totals[g.currency] = (totals[g.currency] ?? 0) + sum;
  }
  return totals;
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
  // A scenario adjusts the projected region, so with no projection there is
  // nothing for it to adjust. Refused rather than ignored: a caller who asked
  // for assumptions and silently got none back is the failure the feature
  // exists to prevent.
  if (q.scenarioModelId && !q.forecast) {
    throw new CostQueryError(
      "scenarioModelId requires forecast: true — there is nothing to adjust otherwise",
    );
  }

  // Text queries are compiled to the structured filter here and nowhere else.
  // Everything below — and everything in `cost-readers.ts` — sees only
  // `CostFilter[]`, whose values are bound as ClickHouse parameters.
  //
  // A saved filter is different from the query/filters pair: those are two
  // spellings of one filter (alternatives), while `savedFilterId` composes —
  // its resolved terms are ANDed with whichever inline spelling was sent.
  // Resolving here, in the shared service rather than the HTTP route, is what
  // gives MCP, chat and the CLI identical behaviour. A reference that fails to
  // resolve is an error, never a fall-through to unfiltered: unfiltered spend
  // quietly standing in for "prod only" is the failure this feature must never
  // produce.
  const inlineFilters = resolveQueryFilters(q);
  let filters = inlineFilters;
  if (q.savedFilterId) {
    try {
      filters = [
        ...(await resolveSavedCostFilters(organizationId, q.savedFilterId)),
        ...inlineFilters,
      ];
    } catch (e) {
      if (e instanceof SavedCostFilterResolutionError) throw new CostQueryError(e.message);
      throw e;
    }
  }

  // The org's billing rules, resolved here for exactly the reason saved
  // filters are: one resolver, so the HTTP API, MCP, chat and the CLI all get
  // the same adjusted number. Resolved only when asked — an unadjusted query
  // does not read the rules table at all, so the common path is unchanged.
  //
  // A rule set is always produced when `adjusted` is set, even when the org has
  // no rules: `adjustment`'s presence on the response is the *only* signal that
  // a number is adjusted, so an org with no rules must not be able to return an
  // adjusted-looking response without it.
  let adjustments: CompiledBillingAdjustments | undefined;
  let adjustmentSummary: CostAdjustmentSummary | undefined;
  if (q.adjusted) {
    const resolved = await resolveBillingAdjustments(organizationId);
    adjustments = resolved.adjustments;
    adjustmentSummary = {
      rules: resolved.rules,
      rawTotals: {},
      // Fixed amounts are arithmetic over the range, not a scan: they have no
      // cost row, no day and no provider behind them. Computed once here and
      // reported separately — never folded into `totals`, which is the sum of
      // the series and has to stay that way for every existing client.
      fixedTotals: fixedTotalsForRange(resolved.adjustments.fixed, q.from, q.to),
    };
  }

  const baseQuery = {
    from: q.from,
    to: q.to,
    binning: q.binning,
    groupBy: q.groupBy,
    filters,
    // Passed into the reader rather than applied to its output: the factors and
    // the reallocation compile into the statement that was going to run anyway,
    // and `sum(raw)` rides along as a second aggregate over the same scan.
    // Skipped entirely when the org has no rules in force, so "adjusted" in an
    // org with no rules costs nothing and returns the collected numbers.
    ...(adjustments && !billingAdjustmentsAreEmpty(adjustments) ? { adjustments } : {}),
    ...(q.groupByTagKey ? { groupByTagKey: q.groupByTagKey } : {}),
    // Carried on the base query so the comparison period is measured on the
    // same basis and the same charge types — a cash previous period against an
    // amortized current one is a comparison of two different questions.
    ...(q.costBasis ? { costBasis: q.costBasis } : {}),
    ...(q.chargeTypes && q.chargeTypes.length > 0 ? { chargeTypes: q.chargeTypes } : {}),
  };

  // Conversion is opt-in twice over: the caller has to ask for a display
  // currency AND the org has to have configured one. Absent either, this
  // resolves to `{ displayCurrency: null }` and every step below is a no-op —
  // the response is byte-identical to what it has always been.
  const { displayCurrency, rates } = await loadConversionContext(organizationId, q.displayCurrency);

  /**
   * Convert, then merge, then fold — in that order, deliberately.
   *
   * Folding first would rank the top N *within each currency* and then merge,
   * giving up to N series per currency and an "Other" per currency, which is
   * exactly the mixed-currency mess this feature exists to remove. Converting
   * first makes "the top 5 services" a question about one number again.
   */
  const convert = (raw: CostSeriesGroup[]) => {
    const { groups, conversion } = convertGroups(raw, displayCurrency, rates);
    return { grouped: foldTopN(mergeConvertedGroups(groups), q.topN), conversion };
  };

  const { grouped, conversion } = convert(await queryCosts(organizationId, baseQuery));
  const series = await labelSeries(organizationId, q.groupBy, grouped);

  const response: CostQueryResponse = {
    series,
    currencies: [...new Set(grouped.map((g) => g.currency))].sort(),
    totals: totalsOf(grouped, q.binning),
  };
  // Only set when something was actually converted. Its absence is how a client
  // knows the per-currency numbers are the literal collected ones.
  if (conversion) response.conversion = conversion;

  // The raw-vs-adjusted contract, honoured here and nowhere else: an adjusted
  // response cannot leave this function without the collected totals and the
  // rules that moved them. When no rule was in force the reader never emitted
  // `rawPoints`, and the collected totals are the totals — which is the true
  // answer, not a placeholder.
  if (adjustmentSummary) {
    const rawTotals = rawTotalsOf(grouped, q.binning);
    adjustmentSummary.rawTotals =
      Object.keys(rawTotals).length > 0 ? rawTotals : { ...response.totals };
    response.adjustment = adjustmentSummary;
  }

  if (q.comparePreviousPeriod) {
    const span = daySpan(q.from, q.to);
    // Converted at the rates in force during the *previous* period, not the
    // current one: a period-over-period comparison whose two halves used the
    // same rate would hide a real currency movement inside an apparent spend
    // change, and one that re-converted history at today's rate would restate
    // a number the org already reconciled.
    const { grouped: prevGrouped } = convert(
      await queryCosts(organizationId, {
        ...baseQuery,
        from: addDays(q.from, -span),
        to: addDays(q.to, -span),
      }),
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
      // The *resolved* filters, not `q.filters`: a request filtered through a
      // text query or a saved filter must fit its forecast on the same slice
      // it is drawing, or the projection trends spend the chart excludes.
      filters,
      // Fit on the basis being drawn: projecting a cash series that contains a
      // one-off commitment purchase forecasts a month-end total that cannot
      // happen, which is the whole reason the amortized basis exists.
      ...(q.costBasis ? { costBasis: q.costBasis } : {}),
      // Same rule for adjustments: a forecast drawn under an adjusted chart has
      // to trend the line it sits under, or the projection visibly starts at a
      // different level from the last bar it continues.
      ...(adjustments && !billingAdjustmentsAreEmpty(adjustments) ? { adjustments } : {}),
      ...(q.chargeTypes && q.chargeTypes.length > 0 ? { chargeTypes: q.chargeTypes } : {}),
    });
    // The fit sums across currencies, so converting first is what makes the
    // projection mean anything at all in a mixed-currency org — otherwise it
    // adds euros to dollars and trends the result.
    const { groups: fitConverted } = convertGroups(fitGroups, displayCurrency, rates);
    const dailyTotals = new Map<string, number>();
    for (const g of fitConverted) {
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

  // The scenario overlay. Deliberately the last thing that happens, on top of
  // an already-complete response: `response.forecast` is the trend and stays
  // the trend, and `response.scenario` is the same days with the model applied.
  // Both are returned, always — see `client-core/cost-scenarios.ts`.
  if (q.scenarioModelId) {
    try {
      const scenario = await attachCostScenario({
        organizationId,
        scenarioModelId: q.scenarioModelId,
        forecast: response.forecast,
        filters,
        fitTo: q.to,
        ...(q.costBasis ? { costBasis: q.costBasis } : {}),
        ...(q.chargeTypes && q.chargeTypes.length > 0 ? { chargeTypes: q.chargeTypes } : {}),
        currencies: response.currencies,
        displayCurrency,
        rates,
      });
      if (scenario) response.scenario = scenario;
    } catch (e) {
      if (e instanceof CostScenarioError) throw new CostQueryError(e.message);
      throw e;
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
  if (!(COST_DIMENSIONS as readonly string[]).includes(dimension)) {
    throw new CostQueryError("Invalid dimension");
  }
  const dim = dimension as CostDimensionId;
  if (dim === "tag" && !tagKey) {
    throw new CostQueryError("tagKey is required for the tag dimension");
  }

  // Charge types are a closed set, not a discovery: answering from a DISTINCT
  // query would leave the picker empty until a provider happened to bill a
  // credit, so an operator could never filter *out* the credits they already
  // suspect are hiding growth. The labelled union is always offered.
  if (dim === "charge_type") {
    return COST_CHARGE_TYPES.map((value) => ({ value, label: COST_CHARGE_TYPE_LABELS[value] }));
  }

  const values = await getCostDimensionValues(organizationId, dim, {
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
        // Both default false, which is also what an account with no cost
        // capability at all reports: a plugin that never says it distinguishes
        // charge types writes every row as usage, and one that never says it
        // amortizes has no second number to show.
        chargeTypes: capability?.chargeTypes ?? false,
        amortization: capability?.amortization ?? false,
        // False means the provider reported the money. True means we priced it
        // ourselves, which the surfaces have to say out loud.
        estimated: capability?.estimated ?? false,
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
