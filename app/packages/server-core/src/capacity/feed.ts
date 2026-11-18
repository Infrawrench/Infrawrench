/**
 * The capacity runway feed: every declared usage on the org's resources, with
 * when it reaches its limit, or what a monthly allowance will reach by the end
 * of its cycle.
 *
 * A read over stored rows only, no provider call: the current value is the
 * resource's synced `fields`, the history is `resource_capacity_snapshots`
 * (written by the sync) for field and output usages and the hourly metric
 * rollup for metric usages. The page, the per-resource chart, the CLI and the
 * daily alert all come through here, so they agree.
 */
import { and, asc, eq, gte, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import {
  capacityDeclarations,
  readCapacityNumber,
  resolveCapacityLimit,
  type CapacityDeclarationEntry,
} from "@infrawrench/plugin-base";
import {
  RUNWAY_WINDOW_DAYS,
  currentCycle,
  forecastAllowance,
  forecastRunway,
  parseCycleInstant,
  runwayStatus,
  sortRunwayRows,
  type ResourceRunwayResponse,
  type ResourceRunwayRow,
  type RunwayListResponse,
  type RunwayPoint,
  type RunwayRow,
} from "@infrawrench/client-core";

import { getMetricHourlyPeaksBatch } from "../analytics/readers";
import { db } from "../db/client";
import { accounts, resourceCapacitySnapshots, resources } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { getQuotaSettings } from "../quotas/settings";
import { capacityValues } from "./record";

const DAY_MS = 86_400_000;

/**
 * How far back the snapshot read goes: the trend window or a whole billing
 * cycle, whichever is longer, plus a margin for a cycle anchored a few days
 * into the month.
 */
const HISTORY_DAYS = 35;

/** Retention for the snapshot series: two months past the longest read. */
export const CAPACITY_SNAPSHOT_RETENTION_DAYS = 120;

type DeclaredTypes = Map<string, Map<string, CapacityDeclarationEntry[]>>;

async function declaredTypes(): Promise<DeclaredTypes> {
  const out: DeclaredTypes = new Map();
  for (const { plugin } of await loadPlugins()) {
    for (const type of plugin.resourceTypes) {
      const entries = capacityDeclarations(type);
      if (entries.length === 0) continue;
      let byType = out.get(plugin.manifest.id);
      if (!byType) {
        byType = new Map();
        out.set(plugin.manifest.id, byType);
      }
      byType.set(type.id, entries);
    }
  }
  return out;
}

function pairCondition(declared: DeclaredTypes): SQL | undefined {
  const pairs: SQL[] = [];
  for (const [pluginId, byType] of declared) {
    pairs.push(
      and(eq(resources.pluginId, pluginId), inArray(resources.resourceTypeId, [...byType.keys()]))!,
    );
  }
  return pairs.length > 0 ? or(...pairs) : undefined;
}

interface Built {
  rows: ResourceRunwayRow[];
  runwayDays: number;
  allowanceThreshold: number;
}

async function buildRunway(
  organizationId: string,
  now: Date,
  resourceId: string | null,
): Promise<Built> {
  const settings = await getQuotaSettings(organizationId);
  const thresholds = {
    runwayDays: settings.runwayDays,
    allowanceThreshold: settings.allowanceThreshold,
  };
  const declared = await declaredTypes();
  const pairs = pairCondition(declared);
  if (!pairs) return { rows: [], ...thresholds };

  // Soft-deleted accounts and resources are left out: their stored fields
  // stop moving the moment the sync stops, and a frozen reading would sit on
  // the list (and page somebody) about something nobody can act on.
  const stored = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      accountName: accounts.displayName,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      displayName: resources.displayName,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
      lastSyncedAt: resources.lastSyncedAt,
    })
    .from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(
      and(
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
        isNull(accounts.deletedAt),
        pairs,
        ...(resourceId ? [eq(resources.id, resourceId)] : []),
      ),
    );
  if (stored.length === 0) return { rows: [], ...thresholds };

  const since = new Date(now.getTime() - HISTORY_DAYS * DAY_MS);
  const snapshots = await db
    .select({
      resourceId: resourceCapacitySnapshots.resourceId,
      capacityKey: resourceCapacitySnapshots.capacityKey,
      used: resourceCapacitySnapshots.used,
      limit: resourceCapacitySnapshots.capacityLimit,
      observedAt: resourceCapacitySnapshots.observedAt,
    })
    .from(resourceCapacitySnapshots)
    .where(
      and(
        eq(resourceCapacitySnapshots.organizationId, organizationId),
        gte(resourceCapacitySnapshots.observedAt, since),
        ...(resourceId ? [eq(resourceCapacitySnapshots.resourceId, resourceId)] : []),
      ),
    )
    .orderBy(asc(resourceCapacitySnapshots.observedAt));
  const history = new Map<string, RunwayPoint[]>();
  for (const s of snapshots) {
    const key = `${s.resourceId}\u0000${s.capacityKey}`;
    const point = { observedAt: s.observedAt.toISOString(), used: s.used, limit: s.limit };
    const list = history.get(key);
    if (list) list.push(point);
    else history.set(key, [point]);
  }

  // Metric usages: hourly peaks over the trend window, for the resources that
  // declare one. Only resources whose metrics are stored have any.
  const metricResourceIds: string[] = [];
  const metricLabels = new Set<string>();
  for (const r of stored) {
    for (const entry of declared.get(r.pluginId)?.get(r.resourceTypeId) ?? []) {
      if (entry.source !== "metric") continue;
      metricResourceIds.push(r.id);
      metricLabels.add(entry.valueKey);
    }
  }
  const peaks = await getMetricHourlyPeaksBatch(
    organizationId,
    [...new Set(metricResourceIds)],
    [...metricLabels],
    now.getTime() - RUNWAY_WINDOW_DAYS * DAY_MS,
    now.getTime(),
  );
  const metricSeries = new Map<string, Array<{ tsMs: number; value: number }>>();
  for (const p of peaks) {
    const key = `${p.resourceId}\u0000metric:${p.seriesLabel}`;
    const list = metricSeries.get(key);
    if (list) list.push(p);
    else metricSeries.set(key, [p]);
  }

  const rows: ResourceRunwayRow[] = [];
  const windowStart = now.getTime() - RUNWAY_WINDOW_DAYS * DAY_MS;
  for (const r of stored) {
    const values = capacityValues(r.fieldsJson, r.outputsJson);
    for (const entry of declared.get(r.pluginId)?.get(r.resourceTypeId) ?? []) {
      const limit = resolveCapacityLimit(entry.declaration.limit, values);
      if (!limit) continue;
      const seriesKey = `${r.id}\u0000${entry.key}`;

      let used: number | null;
      let observedAt: string;
      let points: RunwayPoint[];
      if (entry.source === "metric") {
        const series = metricSeries.get(seriesKey) ?? [];
        const last = series[series.length - 1];
        if (!last) continue;
        used = last.value;
        observedAt = new Date(last.tsMs).toISOString();
        points = series.map((p) => ({
          observedAt: new Date(p.tsMs).toISOString(),
          used: p.value,
          limit: limit.limit,
        }));
      } else {
        used = readCapacityNumber(values[entry.valueKey]);
        if (used === null) continue;
        used = Math.max(0, used);
        observedAt = (r.lastSyncedAt ?? now).toISOString();
        points = history.get(seriesKey) ?? [];
      }

      const cycleDecl = entry.declaration.cycle;
      const base = {
        key: entry.key,
        resourceId: r.id,
        resourceName: r.displayName,
        resourceTypeId: r.resourceTypeId,
        accountId: r.accountId,
        accountName: r.accountName,
        pluginId: r.pluginId,
        label: entry.label,
        unit: entry.declaration.unit ?? null,
        used,
        limit: limit.limit,
        utilization: used / limit.limit,
        limitSource: limit.source,
        plan: limit.plan,
        source: entry.source,
        observedAt,
      };

      let row: Omit<RunwayRow, "status">;
      let shown: RunwayPoint[];
      if (cycleDecl && entry.source !== "metric") {
        const cycle = currentCycle(now, {
          start: cycleDecl.startField ? parseCycleInstant(values[cycleDecl.startField]) : null,
          end: cycleDecl.endField ? parseCycleInstant(values[cycleDecl.endField]) : null,
          ...(cycleDecl.anchorDay !== undefined ? { anchorDay: cycleDecl.anchorDay } : {}),
        });
        const projected = forecastAllowance(points, used, limit.limit, cycle, now);
        row = { ...base, kind: "allowance", forecast: projected.forecast, cycle: projected.cycle };
        shown = points.filter((p) => Date.parse(p.observedAt) >= cycle.start.getTime());
      } else {
        shown = points.filter((p) => Date.parse(p.observedAt) >= windowStart);
        row = {
          ...base,
          kind: "runway",
          forecast: forecastRunway(shown, used, limit.limit, now),
          cycle: null,
        };
      }
      rows.push({ ...row, status: runwayStatus(row, thresholds), history: shown });
    }
  }

  return { rows: sortRunwayRows(rows), ...thresholds };
}

/** The org's runway list, soonest to run out first. No history: the list draws no chart. */
export async function getRunwayFeed(
  organizationId: string,
  now = new Date(),
): Promise<RunwayListResponse> {
  const built = await buildRunway(organizationId, now, null);
  return {
    rows: built.rows.map(({ history: _history, ...row }) => row),
    runwayDays: built.runwayDays,
    allowanceThreshold: built.allowanceThreshold,
    windowDays: RUNWAY_WINDOW_DAYS,
  };
}

/** One resource's usages with the readings the detail chart draws. */
export async function getResourceRunway(
  organizationId: string,
  resourceId: string,
  now = new Date(),
): Promise<ResourceRunwayResponse> {
  const built = await buildRunway(organizationId, now, resourceId);
  return {
    rows: built.rows,
    runwayDays: built.runwayDays,
    allowanceThreshold: built.allowanceThreshold,
    windowDays: RUNWAY_WINDOW_DAYS,
  };
}

const SNAPSHOT_PRUNE_BATCH_SIZE = 2_000;
const MAX_SNAPSHOT_PRUNE_BATCHES = 25;

/**
 * Prune capacity readings past retention, in bounded batches like the quota
 * snapshot prune. Idempotent, so replicas repeating it cost an index probe.
 */
export async function pruneCapacitySnapshots(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CAPACITY_SNAPSHOT_RETENTION_DAYS * DAY_MS);
  let deleted = 0;
  for (let batch = 0; batch < MAX_SNAPSHOT_PRUNE_BATCHES; batch++) {
    const due = await db
      .select({ id: resourceCapacitySnapshots.id })
      .from(resourceCapacitySnapshots)
      .where(lt(resourceCapacitySnapshots.observedAt, cutoff))
      .limit(SNAPSHOT_PRUNE_BATCH_SIZE);
    if (due.length === 0) break;
    await db.delete(resourceCapacitySnapshots).where(
      inArray(
        resourceCapacitySnapshots.id,
        due.map((r) => r.id),
      ),
    );
    deleted += due.length;
    if (due.length < SNAPSHOT_PRUNE_BATCH_SIZE) break;
  }
  return deleted;
}
