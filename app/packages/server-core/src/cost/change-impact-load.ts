/**
 * Cost per change / cost per deploy — the gathering half.
 *
 * The arithmetic is in `change-impact.ts` (pure). This module reads what that
 * function needs: the change rows, the resources they name, the accounts'
 * collection coverage, the daily cost series, and how many other changes
 * touched the same resource in the same window.
 *
 * ## Computed lazily, on read — deliberately
 *
 * There is no `change_cost_impacts` table and nothing here is cached. Provider
 * billing arrives late and is then *restated* (`DEFAULT_RESTATEMENT_DAYS`, and
 * far more for the period-native plugins), so a number computed the day after
 * a deploy is computed against data that is still filling in. A stored answer
 * would freeze that wrong number and would need an invalidation rule that
 * mirrored every collector's restatement horizon — a rule that is wrong the
 * moment a plugin changes its own. Recomputing on read makes "the number
 * updates as data arrives" a property of the design rather than a background
 * job that must not fail. The cost is two ClickHouse reads per request, both
 * of which are the same range-scans the cost graphs already do.
 *
 * It lives in `server-core` rather than `web` because the weekly digest runs in
 * the **poller**, which cannot import web — the same reason `runDeployment`
 * moved here.
 */

import type {
  ChangeCostImpact,
  ChangeCostImpactEntry,
  CostBasis,
  DeploymentCostImpact,
  DeploymentCostImpactResource,
} from "@infrawrench/client-core";
import { clampChangeImpactWindowDays, MAX_CHANGE_IMPACT_BATCH } from "@infrawrench/client-core";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getCostCoverage, queryCosts } from "../clickhouse/cost-readers";
import { db } from "../db/client";
import { deploymentRuns, resourceChanges, resources } from "../db/schema";
import { getPlugin } from "../plugin-loader";
import {
  changeImpactFetchRange,
  computeChangeCostImpact,
  sumChangeCostImpacts,
} from "./change-impact";
import { addDays, isoDay } from "./dates";

export interface ChangeImpactOptions {
  windowDays?: number | undefined;
  costBasis?: CostBasis | undefined;
  /** Injectable for tests; defaults to the process clock. */
  now?: Date | undefined;
}

/** A change event reduced to what the impact computation needs. */
interface ImpactSubject {
  /** Identifies the row in the caller's answer. Empty for a deployment resource. */
  key: string;
  /** `resources.id` — what `resource_changes.resource_id` holds. */
  resourceId: string;
  accountId: string;
  pluginId: string;
  eventDay: string;
  /** Excluded from the overlap count: a change never overlaps itself. */
  selfChangeId: string | null;
}

/**
 * Does this plugin date whole invoice periods to the period start? Cached by
 * the plugin loader, so this is a map lookup after the first call.
 */
async function isPeriodNative(pluginId: string): Promise<boolean> {
  const loaded = await getPlugin(pluginId);
  return loaded?.plugin.manifest.costs?.periodNative === true;
}

/**
 * Per-currency daily spend for each `external_id`, in one read.
 *
 * Grouped by the resource dimension and filtered to the ids in play, which is
 * the same range-scan a resource-grouped cost graph runs. The account filter
 * narrows it further; a provider id colliding across two accounts in one org
 * would fold together here, which is a theoretical loss we accept rather than
 * issue one query per resource.
 */
async function loadResourceSeries(
  organizationId: string,
  externalIds: string[],
  accountIds: string[],
  range: { from: string; to: string },
  costBasis: CostBasis,
): Promise<
  Map<string, Array<{ currency: string; points: Array<{ day: string; amount: number }> }>>
> {
  const byResource = new Map<
    string,
    Array<{ currency: string; points: Array<{ day: string; amount: number }> }>
  >();
  if (externalIds.length === 0) return byResource;

  const groups = await queryCosts(organizationId, {
    from: range.from,
    to: range.to,
    binning: "daily",
    groupBy: "resource",
    costBasis,
    filters: [
      { dimension: "resource", op: "in", values: externalIds },
      ...(accountIds.length > 0
        ? [{ dimension: "account" as const, op: "in" as const, values: accountIds }]
        : []),
    ],
  });

  for (const group of groups) {
    const existing = byResource.get(group.key) ?? [];
    existing.push({
      currency: group.currency,
      points: group.points.map((p) => ({ day: p.bucket, amount: p.amount })),
    });
    byResource.set(group.key, existing);
  }
  return byResource;
}

/**
 * How many *other* recorded changes touched each resource inside its own union
 * window. One indexed read over `(resource_id, created_at)` for the whole
 * batch; the per-subject window test is done in memory because each subject
 * has its own.
 */
async function loadOverlaps(
  organizationId: string,
  subjects: ImpactSubject[],
  windowDays: number,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const s of subjects) counts.set(s.key, 0);

  const resourceIds = [...new Set(subjects.map((s) => s.resourceId))];
  const range = changeImpactFetchRange(
    subjects.map((s) => s.eventDay),
    windowDays,
  );
  if (resourceIds.length === 0 || range === null) return counts;

  const rows = await db
    .select({
      id: resourceChanges.id,
      resourceId: resourceChanges.resourceId,
      createdAt: resourceChanges.createdAt,
    })
    .from(resourceChanges)
    .where(
      and(
        eq(resourceChanges.organizationId, organizationId),
        inArray(resourceChanges.resourceId, resourceIds),
        gte(resourceChanges.createdAt, new Date(`${range.from}T00:00:00.000Z`)),
        // Exclusive upper bound on the day *after* the range, so the whole of
        // the last day is included.
        lte(resourceChanges.createdAt, new Date(`${addDays(range.to, 1)}T00:00:00.000Z`)),
      ),
    );

  for (const s of subjects) {
    const from = addDays(s.eventDay, -windowDays);
    const to = addDays(s.eventDay, windowDays);
    let n = 0;
    for (const row of rows) {
      if (row.resourceId !== s.resourceId) continue;
      if (row.id === s.selfChangeId) continue;
      const day = isoDay(row.createdAt);
      if (day >= from && day <= to) n += 1;
    }
    counts.set(s.key, n);
  }
  return counts;
}

/**
 * Compute an impact for each subject. Shared by the change feed and the
 * deployment breakdown so the two cannot drift into different definitions of
 * the same delta.
 */
async function computeForSubjects(
  organizationId: string,
  subjects: ImpactSubject[],
  options: ChangeImpactOptions,
): Promise<Map<string, ChangeCostImpact>> {
  const windowDays = clampChangeImpactWindowDays(options.windowDays);
  const costBasis: CostBasis = options.costBasis ?? "cash";
  const today = isoDay(options.now ?? new Date());
  const out = new Map<string, ChangeCostImpact>();
  if (subjects.length === 0) return out;

  // `resource_changes.resource_id` is `resources.id`; `cost_daily.resource_id`
  // is the *provider-native* id. The join between the two is `external_id`,
  // and a resource without one simply cannot be priced.
  const resourceIds = [...new Set(subjects.map((s) => s.resourceId))];
  const resourceRows = await db
    .select({
      id: resources.id,
      externalId: resources.externalId,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), inArray(resources.id, resourceIds)));
  const byResourceId = new Map(resourceRows.map((r) => [r.id, r]));

  const coverage = await getCostCoverage(organizationId);

  const range = changeImpactFetchRange(
    subjects.map((s) => s.eventDay),
    windowDays,
  );
  const externalIds = [
    ...new Set(
      subjects
        .map((s) => byResourceId.get(s.resourceId)?.externalId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  const accountIds = [...new Set(subjects.map((s) => s.accountId))];
  const series =
    range === null
      ? new Map<
          string,
          Array<{ currency: string; points: Array<{ day: string; amount: number }> }>
        >()
      : await loadResourceSeries(organizationId, externalIds, accountIds, range, costBasis);

  const overlaps = await loadOverlaps(organizationId, subjects, windowDays);

  const periodNativeCache = new Map<string, boolean>();
  for (const subject of subjects) {
    const resource = byResourceId.get(subject.resourceId);
    const pluginId = resource?.pluginId ?? subject.pluginId;
    let periodNative = periodNativeCache.get(pluginId);
    if (periodNative === undefined) {
      periodNative = await isPeriodNative(pluginId);
      periodNativeCache.set(pluginId, periodNative);
    }
    const externalId = resource?.externalId ?? null;
    const accountId = resource?.accountId ?? subject.accountId;

    out.set(
      subject.key,
      computeChangeCostImpact({
        eventDay: subject.eventDay,
        today,
        windowDays,
        costBasis,
        coverage: coverage.get(accountId) ?? null,
        series: externalId ? (series.get(externalId) ?? []) : [],
        periodNative,
        overlappingChanges: overlaps.get(subject.key) ?? 0,
        costAddressable: Boolean(externalId),
      }),
    );
  }
  return out;
}

/**
 * Cost impact for a batch of change-feed rows. Ids that do not belong to the
 * org are simply absent from the result — never a 404 for the whole page.
 */
export async function loadChangeCostImpacts(
  organizationId: string,
  changeIds: string[],
  options: ChangeImpactOptions = {},
): Promise<ChangeCostImpactEntry[]> {
  const ids = [...new Set(changeIds)].slice(0, MAX_CHANGE_IMPACT_BATCH);
  if (ids.length === 0) return [];

  const rows = await db
    .select({
      id: resourceChanges.id,
      resourceId: resourceChanges.resourceId,
      accountId: resourceChanges.accountId,
      pluginId: resourceChanges.pluginId,
      createdAt: resourceChanges.createdAt,
    })
    .from(resourceChanges)
    .where(
      and(eq(resourceChanges.organizationId, organizationId), inArray(resourceChanges.id, ids)),
    );
  if (rows.length === 0) return [];

  const subjects: ImpactSubject[] = rows.map((r) => ({
    key: r.id,
    resourceId: r.resourceId,
    accountId: r.accountId,
    pluginId: r.pluginId,
    eventDay: isoDay(r.createdAt),
    selfChangeId: r.id,
  }));

  const impacts = await computeForSubjects(organizationId, subjects, options);
  return rows.flatMap((r) => {
    const impact = impacts.get(r.id);
    return impact ? [{ changeId: r.id, resourceId: r.resourceId, impact }] : [];
  });
}

/** One change's impact, or null when the id is not this org's. */
export async function loadChangeCostImpact(
  organizationId: string,
  changeId: string,
  options: ChangeImpactOptions = {},
): Promise<ChangeCostImpactEntry | null> {
  const [entry] = await loadChangeCostImpacts(organizationId, [changeId], options);
  return entry ?? null;
}

/**
 * Cost impact for a deployment run, broken down per resource.
 *
 * The set of resources is `deployment_runs.created_resources` — the resources
 * the run actually provisioned through `infra.accounts.*.create(...)`. That is
 * the only set the platform can attribute to a run with certainty; a deploy
 * that merely re-shipped an image links to nothing and honestly reports an
 * empty breakdown rather than blaming whatever drifted in the same hour.
 *
 * The event day is the run's **start**, not its finish: a long build's cost
 * consequences begin when the resources appear.
 */
export async function loadDeploymentCostImpact(
  organizationId: string,
  runId: string,
  options: ChangeImpactOptions = {},
): Promise<DeploymentCostImpact | null> {
  const [run] = await db
    .select({
      id: deploymentRuns.id,
      createdResources: deploymentRuns.createdResources,
      startedAt: deploymentRuns.startedAt,
    })
    .from(deploymentRuns)
    .where(and(eq(deploymentRuns.organizationId, organizationId), eq(deploymentRuns.id, runId)))
    .limit(1);
  if (!run) return null;

  const windowDays = clampChangeImpactWindowDays(options.windowDays);
  const costBasis: CostBasis = options.costBasis ?? "cash";
  const created = Array.isArray(run.createdResources) ? run.createdResources : [];
  const eventDay = isoDay(run.startedAt);

  const subjects: ImpactSubject[] = created.map((r) => ({
    key: r.resourceId,
    resourceId: r.resourceId,
    accountId: r.accountId,
    pluginId: r.pluginId,
    eventDay,
    // A deployment is not itself a `resource_changes` row, so every change to
    // the resource in the window is genuinely someone else's.
    selfChangeId: null,
  }));

  const impacts = await computeForSubjects(organizationId, subjects, options);
  const rows: DeploymentCostImpactResource[] = created.flatMap((r) => {
    const impact = impacts.get(r.resourceId);
    return impact
      ? [
          {
            resourceId: r.resourceId,
            displayName: r.displayName,
            pluginId: r.pluginId,
            resourceTypeId: r.resourceTypeId,
            impact,
          },
        ]
      : [];
  });

  const { total, unknownResources, confidence } = sumChangeCostImpacts(rows.map((r) => r.impact));
  return {
    runId: run.id,
    costBasis,
    windowDays,
    eventDay,
    resources: rows,
    total,
    unknownResources,
    confidence,
  };
}

/**
 * Human label for a change, used as the cost annotation's subject. Kept beside
 * the loaders so the annotation and the UI name the same thing.
 */
export async function describeChangeSubject(
  organizationId: string,
  changeId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ displayName: resourceChanges.displayName, changeKind: resourceChanges.changeKind })
    .from(resourceChanges)
    .where(
      and(eq(resourceChanges.organizationId, organizationId), eq(resourceChanges.id, changeId)),
    )
    .limit(1);
  return row ? `${row.displayName} ${row.changeKind}` : null;
}

/** Human label for a deployment run. */
export async function describeDeploymentSubject(
  organizationId: string,
  runId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ env: deploymentRuns.env, repo: deploymentRuns.repo, gitSha: deploymentRuns.gitSha })
    .from(deploymentRuns)
    .where(and(eq(deploymentRuns.organizationId, organizationId), eq(deploymentRuns.id, runId)))
    .limit(1);
  if (!row) return null;
  const sha = row.gitSha ? ` @ ${row.gitSha.slice(0, 7)}` : "";
  return `${row.repo ?? "local"} → ${row.env}${sha}`;
}
