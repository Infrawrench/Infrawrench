import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type {
  DashboardStat,
  MetricSeries,
  Plugin,
  PluginClient,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { db } from "./db/client";
import { accounts, dashboardPins, resources } from "./db/schema";
import { decrypt, buildAad } from "./encryption";
import { getPlugin } from "./plugin-loader";
import { buildPluginHostServices } from "./host-services";
import { rewriteCredentialsThroughTunnel } from "./tunnel-resolver";
import {
  flattenMetricSeries,
  insertAccountResourceCounts,
  insertDashboardStats,
  insertMetricPoints,
  insertPollOutcome,
} from "./clickhouse/writers";

/** Returns only top-level resource types (no parent) — duplicated from
 * @infrawrench/ui to avoid a server→React-package dependency. */
function listableTopLevelTypes<T extends { parentTypeId?: string }>(types: T[]): T[] {
  return types.filter((t) => !t.parentTypeId);
}

/**
 * Load the plugin + decrypted credentials for an account and build a ready-to-use client.
 * Callers are responsible for wrapping errors.
 */
async function loadAccountClient(accountId: string, organizationId: string) {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)));
  if (!account) throw new Error("Account not found");

  const loaded = await getPlugin(account.pluginId);
  if (!loaded) throw new Error(`Plugin "${account.pluginId}" not loaded`);

  const plaintext = await decrypt(
    account.encryptedCredentials,
    account.credentialsIv,
    buildAad("account", account.id, "credentials"),
  );
  const credentials = JSON.parse(plaintext) as Record<string, string>;
  await rewriteCredentialsThroughTunnel(accountId, credentials);

  const hostServices = buildPluginHostServices(loaded.plugin.manifest, credentials);
  const client = loaded.plugin.createClient(credentials, hostServices);
  return { account, plugin: loaded.plugin, client };
}

/** Upsert one resource row and bump its syncVersion. */
async function upsertResource(
  organizationId: string,
  accountId: string,
  r: ResourceInstance,
): Promise<void> {
  const nextVersion = sql<number>`COALESCE((SELECT MAX(sync_version) FROM resources WHERE organization_id = ${organizationId}), 0) + 1`;
  await db
    .insert(resources)
    .values({
      id: r.id,
      organizationId,
      pluginId: r.pluginId,
      resourceTypeId: r.resourceTypeId,
      accountId,
      displayName: r.displayName,
      externalId: r.externalId ?? null,
      fieldsJson: r.fields ?? {},
      outputsJson: r.resolvedOutputs ?? {},
      parentResourceId: r.parentResourceId ?? null,
      lastSyncedAt: new Date(),
      syncVersion: nextVersion,
      deletedAt: null,
    })
    .onConflictDoUpdate({
      target: resources.id,
      set: {
        displayName: r.displayName,
        // Merge with existing JSON so user-supplied keys not returned by the
        // plugin's lister (e.g. a Cloud SQL root password set at create time)
        // survive subsequent syncs. New values from the lister win.
        fieldsJson: sql`COALESCE(${resources.fieldsJson}, '{}'::jsonb) || ${JSON.stringify(r.fields ?? {})}::jsonb`,
        outputsJson: sql`COALESCE(${resources.outputsJson}, '{}'::jsonb) || ${JSON.stringify(r.resolvedOutputs ?? {})}::jsonb`,
        parentResourceId: r.parentResourceId ?? null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
        syncVersion: nextVersion,
        deletedAt: null,
      },
    });
}

/** Sync one resource type for an account. Returns the fresh resources. */
export async function syncAccountResourceType(
  accountId: string,
  organizationId: string,
  typeId: string,
): Promise<ResourceInstance[]> {
  const { plugin, client } = await loadAccountClient(accountId, organizationId);

  const typeDef = plugin.resourceTypes.find((t) => t.id === typeId);
  if (!typeDef) throw new Error(`Resource type "${typeId}" not found`);

  const fetched = await client.listResources(typeId, accountId);

  await Promise.all(fetched.map((r) => upsertResource(organizationId, accountId, r)));

  // Soft-delete resources of this type that no longer exist upstream.
  const liveIds = fetched.map((r) => r.id);
  const deleteConditions = [
    eq(resources.accountId, accountId),
    eq(resources.organizationId, organizationId),
    eq(resources.resourceTypeId, typeId),
    isNull(resources.deletedAt),
    isNotNull(resources.lastSyncedAt),
  ];
  if (liveIds.length > 0) {
    deleteConditions.push(notInArray(resources.id, liveIds));
  }
  await db
    .update(resources)
    .set({
      deletedAt: new Date(),
      syncVersion: sql<number>`COALESCE((SELECT MAX(sync_version) FROM resources WHERE organization_id = ${organizationId}), 0) + 1`,
    })
    .where(and(...deleteConditions));

  return fetched;
}

interface SyncAccountOptions {
  /**
   * Optional gate called before each resource-type list call. Return false to skip
   * that type this cycle (e.g. token bucket empty). The row stays as-is in DB.
   */
  canListType?: (typeId: string) => boolean;
  /** Called after each type completes (success OR failure). Lets callers record rate-limit usage. */
  onTypeDone?: (typeId: string, outcome: "ok" | "error" | "skipped", error?: Error) => void;
}

interface SyncAccountResult {
  /** Count of resources written across all types that fetched successfully. */
  resourceCount: number;
  /** Resource type IDs that fetched successfully. */
  succeededTypeIds: string[];
  /** Resource type IDs that errored. */
  failedTypeIds: string[];
  /** Resource type IDs the caller told us to skip (rate limited). */
  skippedTypeIds: string[];
  /** First error encountered across types, if any. */
  firstError?: Error;
}

/** Sync all resource types for an account. Returns counts + error metadata for poller backoff. */
export async function syncAccountResources(
  accountId: string,
  organizationId: string,
  options: SyncAccountOptions = {},
): Promise<SyncAccountResult> {
  const pollStart = Date.now();
  const { account, plugin, client } = await loadAccountClient(accountId, organizationId);

  const canListType = options.canListType ?? (() => true);
  const onTypeDone = options.onTypeDone ?? (() => undefined);

  const typeDefs = plugin.resourceTypes;
  const skippedTypeIds: string[] = [];
  const runnableTypeIds: string[] = [];
  for (const t of typeDefs) {
    if (canListType(t.id)) {
      runnableTypeIds.push(t.id);
    } else {
      skippedTypeIds.push(t.id);
      onTypeDone(t.id, "skipped");
    }
  }

  const fetchResults = await Promise.allSettled(
    runnableTypeIds.map((typeId) => client.listResources(typeId, accountId)),
  );

  const allResources: ResourceInstance[] = [];
  const succeededTypeIds: string[] = [];
  const failedTypeIds: string[] = [];
  let firstError: Error | undefined;

  for (let i = 0; i < fetchResults.length; i++) {
    const r = fetchResults[i]!;
    const typeId = runnableTypeIds[i]!;
    if (r.status === "fulfilled") {
      allResources.push(...r.value);
      succeededTypeIds.push(typeId);
      onTypeDone(typeId, "ok");
    } else {
      failedTypeIds.push(typeId);
      const err = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
      if (!firstError) firstError = err;
      onTypeDone(typeId, "error", err);
    }
  }

  await Promise.all(allResources.map((r) => upsertResource(organizationId, accountId, r)));

  // Soft-delete resources whose type succeeded but no longer exist upstream.
  // The provider's list is authoritative: anything we have for a succeeded type
  // that isn't in the live response is gone. Never delete across failed types —
  // transient API errors must not wipe data.
  const liveIds = allResources.map((r) => r.id);
  if (succeededTypeIds.length > 0) {
    const deleteConditions = [
      eq(resources.accountId, accountId),
      eq(resources.organizationId, organizationId),
      isNull(resources.deletedAt),
      inArray(resources.resourceTypeId, succeededTypeIds),
    ];
    if (liveIds.length > 0) deleteConditions.push(notInArray(resources.id, liveIds));
    await db
      .update(resources)
      .set({
        deletedAt: new Date(),
        syncVersion: sql<number>`COALESCE((SELECT MAX(sync_version) FROM resources WHERE organization_id = ${organizationId}), 0) + 1`,
      })
      .where(and(...deleteConditions));
  }

  await refreshPinnedStats(accountId, organizationId, plugin, client);

  await insertPollOutcome({
    organizationId,
    accountId,
    pluginId: account.pluginId,
    ts: new Date(),
    durationMs: Date.now() - pollStart,
    resourceCount: allResources.length,
    succeededTypeCount: succeededTypeIds.length,
    failedTypeCount: failedTypeIds.length,
    skippedTypeCount: skippedTypeIds.length,
    ...(firstError ? { firstError: firstError.message } : {}),
  });

  const result: SyncAccountResult = {
    resourceCount: allResources.length,
    succeededTypeIds,
    failedTypeIds,
    skippedTypeIds,
  };
  if (firstError) result.firstError = firstError;
  return result;
}

/**
 * Fetch dashboard stats + metric series for resources in this account that are pinned
 * on some dashboard, and stream them into ClickHouse. For __account__ pins, write
 * aggregate resource counts. Per-resource failures are swallowed so one plugin
 * error can't poison the cycle.
 */
async function refreshPinnedStats(
  accountId: string,
  organizationId: string,
  plugin: Plugin,
  client: PluginClient,
): Promise<void> {
  const pinned = await db
    .selectDistinct({
      resourceId: resources.id,
      resourceTypeId: resources.resourceTypeId,
      pluginId: resources.pluginId,
    })
    .from(dashboardPins)
    .innerJoin(resources, eq(dashboardPins.resourceId, resources.id))
    .where(
      and(
        eq(resources.accountId, accountId),
        eq(resources.organizationId, organizationId),
        isNull(dashboardPins.deletedAt),
        isNull(resources.deletedAt),
      ),
    );

  const now = new Date();

  const hasAccountPin = pinned.some((p) => p.resourceTypeId === "__account__");
  if (hasAccountPin) {
    const topLevelTypes = listableTopLevelTypes(plugin.resourceTypes);
    const counts = await Promise.allSettled(
      topLevelTypes.map(async (t) => ({
        typeLabel: t.pluralDisplayName,
        count: (await client.listResources(t.id, accountId)).length,
      })),
    );
    const resourceCounts = counts
      .filter(
        (r): r is PromiseFulfilledResult<{ typeLabel: string; count: number }> =>
          r.status === "fulfilled" && r.value.count > 0,
      )
      .map((r) => r.value);
    await insertAccountResourceCounts({
      organizationId,
      accountId,
      ts: now,
      counts: resourceCounts,
    });
  }

  if (!client.fetchDashboardStats) return;

  const fetchStats = client.fetchDashboardStats.bind(client);
  const fetchMetrics = client.fetchMetricSeries?.bind(client);

  await Promise.all(
    pinned
      .filter((p) => p.resourceTypeId !== "__account__")
      .map(async (p) => {
        const typeDef = plugin.resourceTypes.find((t) => t.id === p.resourceTypeId);
        const [statsResult, metricsResult] = await Promise.allSettled([
          fetchStats(p.resourceTypeId, p.resourceId, accountId),
          typeDef?.supportsMetrics && fetchMetrics
            ? fetchMetrics(p.resourceTypeId, p.resourceId, accountId)
            : Promise.resolve(null),
        ]);
        if (statsResult.status === "fulfilled") {
          await insertDashboardStats({
            organizationId,
            accountId,
            resourceId: p.resourceId,
            ts: now,
            stats: statsResult.value as DashboardStat[],
          });
        }
        if (metricsResult.status === "fulfilled" && metricsResult.value) {
          const rows = flattenMetricSeries(
            {
              organizationId,
              accountId,
              resourceId: p.resourceId,
              pluginId: p.pluginId,
              resourceTypeId: p.resourceTypeId,
            },
            metricsResult.value as MetricSeries[],
          );
          await insertMetricPoints(rows);
        }
      }),
  );
}

/** Manually refresh a single resource by calling getResource on the provider. */
async function refreshSingleResource(
  resourceId: string,
  accountId: string,
  organizationId: string,
  typeId: string,
): Promise<ResourceInstance> {
  const { client } = await loadAccountClient(accountId, organizationId);
  const fresh = await client.getResource(typeId, resourceId, accountId);
  await upsertResource(organizationId, accountId, fresh);
  return fresh;
}
