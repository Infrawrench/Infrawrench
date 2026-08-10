import { and, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type {
  DashboardStat,
  MetricSeries,
  PeerPluginIntegration,
  Plugin,
  PluginClient,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { evaluatePeerIntegrationUnreachable } from "@infrawrench/plugin-base";
import { db } from "./db/client";
import { accounts, dashboardPins, resources, secretFieldStates } from "./db/schema";
import { decrypt, encrypt, buildAad } from "./encryption";
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
import {
  computeResourceChangeEvents,
  recordResourceChanges,
  type PriorResourceSnapshot,
  type ResourceChangeEvent,
} from "./resource-changes";

/** Returns resource types listed in the sidebar — top-level plus child types
 * that opted in via `showInSidebar`. Duplicated from @infrawrench/ui to avoid
 * a server→React-package dependency. */
function listableTopLevelTypes<T extends { parentTypeId?: string; showInSidebar?: boolean }>(
  types: T[],
): T[] {
  return types.filter((t) => !t.parentTypeId || t.showInSidebar);
}

/**
 * Load the plugin + decrypted credentials for an account and build a ready-to-use client.
 * Callers are responsible for wrapping errors.
 */
export async function loadAccountClient(accountId: string, organizationId: string) {
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

  const hostServices = await buildPluginHostServices(loaded.plugin.manifest, credentials, {
    accountId,
    bastionId: account.bastionId ?? null,
  });
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

/**
 * Load the stored snapshots the change differ compares fresh fetches against.
 * Must run before the upserts, which overwrite the prior state.
 */
async function loadPriorSnapshots(
  accountId: string,
  organizationId: string,
  typeId?: string,
): Promise<PriorResourceSnapshot[]> {
  const conditions = [
    eq(resources.accountId, accountId),
    eq(resources.organizationId, organizationId),
  ];
  if (typeId) conditions.push(eq(resources.resourceTypeId, typeId));
  return db
    .select({
      id: resources.id,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
      displayName: resources.displayName,
      fieldsJson: resources.fieldsJson,
      outputsJson: resources.outputsJson,
      deletedAt: resources.deletedAt,
    })
    .from(resources)
    .where(and(...conditions));
}

/**
 * Diff prior vs fetched and append events to the change timeline, then hand the
 * events to the caller's `onChanges` hook. Wrapped so a feed failure (or a
 * snapshot-load failure upstream) can never break a sync.
 *
 * The hook exists rather than a direct call to the drift notifier so this
 * module keeps knowing nothing about notification transports — the same
 * separation `onTypeDone` gives the sync-failure pager, which the poller (not
 * this file) wires to `notePollOutcome`.
 */
async function recordChangeTimeline(
  organizationId: string,
  accountId: string,
  prior: PriorResourceSnapshot[],
  fetched: ResourceInstance[],
  deletableTypeIds: string[],
  onChanges?: (events: ResourceChangeEvent[]) => void,
): Promise<void> {
  try {
    const events = computeResourceChangeEvents({ prior, fetched, deletableTypeIds });
    await recordResourceChanges(organizationId, accountId, events);
    onChanges?.(events);
  } catch (err) {
    console.error(`[sync] recording resource changes for account ${accountId} failed:`, err);
  }
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

  const prior = await loadPriorSnapshots(accountId, organizationId, typeId).catch((err) => {
    console.error(`[sync] loading prior snapshots for account ${accountId} failed:`, err);
    return null;
  });

  await Promise.all(fetched.map((r) => upsertResource(organizationId, accountId, r)));

  if (prior) await recordChangeTimeline(organizationId, accountId, prior, fetched, [typeId]);

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
  /**
   * Called once with the change-timeline events this pass recorded, after they
   * are persisted. The background poller uses it to raise batched drift
   * notifications; a manual refresh from the UI leaves it unset and so writes
   * the timeline without notifying, the same line `notePollOutcome` draws for
   * sync incidents.
   */
  onChanges?: (events: ResourceChangeEvent[]) => void;
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

  const prior = await loadPriorSnapshots(accountId, organizationId).catch((err) => {
    console.error(`[sync] loading prior snapshots for account ${accountId} failed:`, err);
    return null;
  });

  await Promise.all(allResources.map((r) => upsertResource(organizationId, accountId, r)));

  if (prior) {
    await recordChangeTimeline(
      organizationId,
      accountId,
      prior,
      allResources,
      succeededTypeIds,
      options.onChanges,
    );
  }

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

  // Re-resolve live output references owned by this account's resources and
  // push any changed values back to the provider. Wrapped so a reconcile
  // failure can never break the poll cycle.
  try {
    await reconcileAccountReferences(accountId, organizationId);
  } catch (err) {
    console.error("[sync] reconcileAccountReferences failed:", err);
  }

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
    for (const [i, r] of counts.entries()) {
      if (r.status === "rejected") {
        // Otherwise the account card just shows one fewer row than reality.
        console.error(
          `[sync] Resource count for ${plugin.manifest.id}/${topLevelTypes[i]?.id} on account ${accountId} failed:`,
          r.reason,
        );
      }
    }
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
        const peerMetricIntegrations = (typeDef?.peerIntegrations ?? []).filter(
          (i) => i.exposeMetricsToParent,
        );
        const [statsResult, metricsResult, peerMetricsResult] = await Promise.allSettled([
          fetchStats(p.resourceTypeId, p.resourceId, accountId),
          typeDef?.supportsMetrics && fetchMetrics
            ? fetchMetrics(p.resourceTypeId, p.resourceId, accountId)
            : Promise.resolve(null),
          peerMetricIntegrations.length
            ? fetchPeerMetricSeriesForPoller(
                client,
                plugin,
                peerMetricIntegrations,
                p.resourceTypeId,
                p.resourceId,
                accountId,
              )
            : Promise.resolve(null),
        ]);
        // A rejected probe leaves the pin's last snapshot in place, which
        // renders as stale-but-fine on the dashboard. Log the reason so the
        // difference between "provider is quiet" and "provider is broken" is
        // visible in the poller's output.
        for (const [label, r] of [
          ["stats", statsResult],
          ["metrics", metricsResult],
          ["peer metrics", peerMetricsResult],
        ] as const) {
          if (r.status === "rejected") {
            console.error(
              `[sync] ${label} probe for ${p.pluginId}/${p.resourceTypeId} ${p.resourceId} failed:`,
              r.reason,
            );
          }
        }
        if (statsResult.status === "fulfilled") {
          await insertDashboardStats({
            organizationId,
            accountId,
            resourceId: p.resourceId,
            ts: now,
            stats: statsResult.value as DashboardStat[],
          });
        }
        const ownSeries =
          metricsResult.status === "fulfilled" && metricsResult.value
            ? (metricsResult.value as MetricSeries[])
            : [];
        const peerSeries =
          peerMetricsResult.status === "fulfilled" && peerMetricsResult.value
            ? peerMetricsResult.value
            : [];
        const allSeries = [...ownSeries, ...peerSeries];
        if (allSeries.length) {
          const rows = flattenMetricSeries(
            {
              organizationId,
              accountId,
              resourceId: p.resourceId,
              pluginId: p.pluginId,
              resourceTypeId: p.resourceTypeId,
            },
            allSeries,
          );
          await insertMetricPoints(rows);
        }
      }),
  );
}

/**
 * Server-side analogue of fetchPeerMetricSeries in the web package — calls
 * each `exposeMetricsToParent` peer's `fetchMetricSeries` against credentials
 * resolved from the parent. Series get prefixed with the peer's tab label so
 * downstream charts can distinguish them from the parent's own metrics.
 * Peer-resolution errors are swallowed so a broken peer can't poison the
 * parent's metrics for the cycle.
 */
async function fetchPeerMetricSeriesForPoller(
  parentClient: PluginClient,
  parentPlugin: Plugin,
  integrations: PeerPluginIntegration[],
  resourceTypeId: string,
  resourceId: string,
  accountId: string,
): Promise<MetricSeries[]> {
  const parentResource = await parentClient
    .getResource(resourceTypeId, resourceId, accountId)
    .catch(() => null);

  const results = await Promise.allSettled(
    integrations.map(async (integration) => {
      if (evaluatePeerIntegrationUnreachable(integration, parentResource?.fields)) return [];
      const peerCreds: Record<string, string> = {};
      for (const mapping of integration.credentialMappings) {
        peerCreds[mapping.credentialKey] = await parentClient.resolveOutput(
          resourceTypeId,
          resourceId,
          mapping.outputKey,
          accountId,
        );
      }
      const peerLoaded = await getPlugin(integration.pluginId);
      if (!peerLoaded) return [];
      const peerHostServices = await buildPluginHostServices(
        peerLoaded.plugin.manifest,
        peerCreds,
        { accountId },
      );
      const peerClient = peerLoaded.plugin.createClient(peerCreds, peerHostServices);
      if (!peerClient.fetchMetricSeries) return [];
      const series = await peerClient.fetchMetricSeries(resourceTypeId, resourceId, accountId);
      return series.map((s) => ({ ...s, label: `${integration.tabLabel} · ${s.label}` }));
    }),
  );
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}

/**
 * Re-resolve every live output reference whose *consumer* resource belongs to
 * this account, and when the source's current value differs from the cached
 * one, push the new value back to the provider via the consumer plugin's
 * `updateResource`. This is what makes an A record track a server's IP, a CNAME
 * track a load balancer's hostname, etc.
 *
 * The source resource usually lives in a *different* account/provider, so we
 * load a client for `source_account_id` to resolve it. Per-reference failures
 * (provider down, output gone, plugin can't update) are swallowed — one broken
 * reference must not stall the rest.
 */
export async function reconcileAccountReferences(
  accountId: string,
  organizationId: string,
): Promise<void> {
  const refs = await db
    .select({
      consumerId: resources.id,
      consumerPluginId: resources.pluginId,
      consumerTypeId: resources.resourceTypeId,
      consumerAccountId: resources.accountId,
      fieldKey: secretFieldStates.fieldKey,
      sourcePluginId: secretFieldStates.sourcePluginId,
      sourceTypeId: secretFieldStates.sourceResourceTypeId,
      sourceResourceId: secretFieldStates.sourceResourceId,
      sourceAccountId: secretFieldStates.sourceAccountId,
      sourceOutputKey: secretFieldStates.sourceOutputKey,
      cachedEncryptedValue: secretFieldStates.cachedEncryptedValue,
      cachedValueIv: secretFieldStates.cachedValueIv,
    })
    .from(secretFieldStates)
    .innerJoin(resources, eq(secretFieldStates.resourceId, resources.id))
    .where(
      and(
        eq(resources.accountId, accountId),
        eq(resources.organizationId, organizationId),
        eq(secretFieldStates.resolutionKind, "output-ref"),
        isNull(resources.deletedAt),
      ),
    );

  if (refs.length === 0) return;

  // Cache one client per source account across the batch. A failure is cached
  // as the error itself so we don't re-attempt a broken credential once per
  // reference — but it is rethrown every time, so the per-reference handler
  // below logs which references were skipped and why.
  type SourceClient = Awaited<ReturnType<typeof loadAccountClient>>;
  const sourceClients = new Map<string, SourceClient | Error>();
  const getSourceClient = async (acctId: string): Promise<SourceClient> => {
    const cached = sourceClients.get(acctId);
    if (cached) {
      if (cached instanceof Error) throw cached;
      return cached;
    }
    try {
      const client = await loadAccountClient(acctId, organizationId);
      sourceClients.set(acctId, client);
      return client;
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      sourceClients.set(acctId, failure);
      throw failure;
    }
  };

  for (const ref of refs) {
    if (
      !ref.sourceAccountId ||
      !ref.sourceTypeId ||
      !ref.sourceResourceId ||
      !ref.sourceOutputKey
    ) {
      continue;
    }
    try {
      const source = await getSourceClient(ref.sourceAccountId);

      const newValue = await source.client.resolveOutput(
        ref.sourceTypeId,
        ref.sourceResourceId,
        ref.sourceOutputKey,
        ref.sourceAccountId,
      );
      if (!newValue) continue;

      let oldValue: string | null = null;
      if (ref.cachedEncryptedValue && ref.cachedValueIv) {
        try {
          oldValue = await decrypt(
            ref.cachedEncryptedValue,
            ref.cachedValueIv,
            buildAad("secretField", `${ref.consumerId}:${ref.fieldKey}`, "cache"),
          );
        } catch (err) {
          // Treat an unreadable cache as "no cache" and re-push, but log it:
          // a systematic decryption failure (key rotation, AAD mismatch) would
          // otherwise show up only as an unexplained write every cycle.
          console.error(
            `[sync] Failed to decrypt cached value for ${ref.consumerId}.${ref.fieldKey}:`,
            err,
          );
          oldValue = null;
        }
      }
      if (oldValue === newValue) continue;

      // Push the new value to the consumer's provider.
      const consumer = await loadAccountClient(ref.consumerAccountId, organizationId);
      if (!consumer.client.updateResource) continue;
      const updated = await consumer.client.updateResource(
        ref.consumerTypeId,
        ref.consumerId,
        ref.consumerAccountId,
        { [ref.fieldKey]: newValue },
      );
      await upsertResource(organizationId, ref.consumerAccountId, updated);

      // Refresh the SWR cache so the next cycle only acts on genuine changes.
      const cache = await encrypt(
        newValue,
        buildAad("secretField", `${ref.consumerId}:${ref.fieldKey}`, "cache"),
      );
      await db
        .update(secretFieldStates)
        .set({
          cachedEncryptedValue: cache.ciphertext,
          cachedValueIv: cache.iv,
          cachedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(secretFieldStates.resourceId, ref.consumerId),
            eq(secretFieldStates.fieldKey, ref.fieldKey),
          ),
        );
    } catch (err) {
      console.error(
        `[sync] Failed to reconcile reference ${ref.consumerId}.${ref.fieldKey}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
