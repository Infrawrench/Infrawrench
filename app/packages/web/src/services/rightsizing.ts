import { and, eq, isNull } from "drizzle-orm";
import type {
  ResourceTypeDefinition,
  RightsizingDeclaration,
  SizeOption,
} from "@infrawrench/plugin-base";
import { getMetricQuantilesBatch } from "@infrawrench/server-core/clickhouse/readers";
import {
  DEFAULT_RIGHTSIZING_THRESHOLDS,
  RIGHTSIZING_WINDOW_DAYS,
  computeSizeRecommendation,
  resolveUtilisation,
  type OversizedAccountGroup,
  type OversizedResource,
  type OversizedSizeSummary,
  type RightsizingListResponse,
  type RightsizingSizeOption,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { loadPlugins } from "../plugins/loader";
import { getClientForAccount } from "./plugin-clients";

/**
 * "Oversized" recommendations — the savings finder's second pass: resources
 * whose plugin declares `rightsizing`, whose stored p95 utilisation over the
 * trailing 14 days sits under the thresholds, matched against the plugin's
 * own size catalog (the create form's size-picker options, prices hydrated
 * through `getCreateSizePricing`).
 *
 * Unlike orphans this can't be a pure read: the size catalogs come from the
 * provider APIs with the account's credentials, and the percentiles from
 * ClickHouse. Both are slow-moving, so the whole org response is cached
 * in-memory for a few minutes and recomputed on demand — there is no poller
 * pass to keep stale rows warm (the orphans shape, not the schedules one).
 *
 * Failure surface, deliberately: a ClickHouse outage throws (the section
 * shows the error instead of "nothing is oversized"), while one account's
 * broken credentials only cost that account's rows — logged `[rightsizing]`,
 * never silent.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  expiresAt: number;
  promise: Promise<RightsizingListResponse>;
}

const responseCache = new Map<string, CacheEntry>();

/**
 * Orgs whose computation is currently running. A `refresh=true` call (or a
 * cache-expiry miss) while one is in flight joins that run instead of
 * stacking a second full provider/ClickHouse sweep.
 */
const inFlight = new Set<string>();

export async function listRightsizing(
  organizationId: string,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<RightsizingListResponse> {
  const cached = responseCache.get(organizationId);
  if (cached && (inFlight.has(organizationId) || (!refresh && cached.expiresAt > Date.now()))) {
    return cached.promise;
  }

  inFlight.add(organizationId);
  const promise = computeRightsizing(organizationId).finally(() => {
    inFlight.delete(organizationId);
  });
  const entry: CacheEntry = { expiresAt: Date.now() + CACHE_TTL_MS, promise };
  responseCache.set(organizationId, entry);
  // A failed computation must not serve from cache until the TTL runs out —
  // drop the entry (only if it is still ours) so the next call retries.
  promise.catch(() => {
    if (responseCache.get(organizationId) === entry) responseCache.delete(organizationId);
  });
  return promise;
}

interface DeclaredType {
  typeDef: ResourceTypeDefinition;
  declaration: RightsizingDeclaration;
  pluginName: string;
}

async function computeRightsizing(organizationId: string): Promise<RightsizingListResponse> {
  const [orgResources, orgAccounts, plugins] = await Promise.all([
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fieldsJson: resources.fieldsJson,
        lastSyncedAt: resources.lastSyncedAt,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt))),
    db
      .select({ id: accounts.id, displayName: accounts.displayName, pluginId: accounts.pluginId })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt))),
    loadPlugins(),
  ]);

  // pluginId → typeId → declaration
  const declared = new Map<string, Map<string, DeclaredType>>();
  for (const { plugin } of plugins) {
    for (const type of plugin.resourceTypes) {
      if (!type.rightsizing) continue;
      let byType = declared.get(plugin.manifest.id);
      if (!byType) {
        byType = new Map();
        declared.set(plugin.manifest.id, byType);
      }
      byType.set(type.id, {
        typeDef: type,
        declaration: type.rightsizing,
        pluginName: plugin.manifest.displayName,
      });
    }
  }

  const accountMap = new Map(orgAccounts.map((a) => [a.id, a]));
  const candidates = orgResources.filter((r) => {
    const entry = declared.get(r.pluginId)?.get(r.resourceTypeId);
    if (!entry || !accountMap.has(r.accountId)) return false;
    // A stopped machine's percentiles describe its idle tail, not its work —
    // and the right fix for one that stays off is a schedule or a delete.
    const lifecycle = entry.typeDef.lifecycle;
    if (lifecycle?.statusFieldKey && lifecycle.stoppedValues) {
      const state = String(asFields(r.fieldsJson)?.[lifecycle.statusFieldKey] ?? "").toLowerCase();
      if (lifecycle.stoppedValues.some((v) => v.toLowerCase() === state)) return false;
    }
    return true;
  });

  const generatedAt = new Date().toISOString();
  if (candidates.length === 0) {
    return { accounts: [], totalCount: 0, windowDays: RIGHTSIZING_WINDOW_DAYS, generatedAt };
  }

  const toMs = Date.now();
  const fromMs = toMs - RIGHTSIZING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const quantilesByResource = await getMetricQuantilesBatch(
    organizationId,
    candidates.map((r) => r.id),
    fromMs,
    toMs,
  );

  // Cheap CPU pre-filter before any provider API call: only resources whose
  // stored p95 CPU is already under the threshold warrant a catalog fetch.
  const thresholds = DEFAULT_RIGHTSIZING_THRESHOLDS;
  const worthCataloguing = candidates.filter((r) => {
    const entry = declared.get(r.pluginId)!.get(r.resourceTypeId)!;
    const cpu = quantilesByResource
      .get(r.id)
      ?.find((q) => q.label === entry.declaration.cpuMetric.seriesLabel);
    if (!cpu || cpu.samples < thresholds.minCoverageMinutes) return false;
    const scale = entry.declaration.cpuMetric.scale === "fraction" ? 100 : 1;
    return cpu.q95 * scale < thresholds.cpuP95Max;
  });

  // One catalog per (account, type); one price overlay per (account, type,
  // region). Both come from the plugin with the account's credentials.
  const catalogCache = new Map<string, Promise<SizeOption[] | null>>();
  const priceCache = new Map<string, Promise<Record<string, number>>>();
  const clientCache = new Map<string, ReturnType<typeof getClientForAccount>>();

  const getCtx = (accountId: string) => {
    let ctx = clientCache.get(accountId);
    if (!ctx) {
      ctx = getClientForAccount(accountId, organizationId);
      clientCache.set(accountId, ctx);
    }
    return ctx;
  };

  const getCatalog = (accountId: string, typeId: string, declaration: RightsizingDeclaration) => {
    const key = `${accountId} ${typeId}`;
    let entry = catalogCache.get(key);
    if (!entry) {
      entry = (async () => {
        const ctx = await getCtx(accountId);
        if (!ctx?.client.getCreateConfig) return null;
        const config = await ctx.client.getCreateConfig(typeId);
        const fieldKey = declaration.createSizeFieldKey ?? declaration.sizeFieldKey;
        const field = config.fields.find((f) => f.key === fieldKey && f.kind === "size-picker");
        return field?.sizes ?? null;
      })().catch((err) => {
        console.error(
          `[rightsizing] size catalog failed for account ${accountId} type ${typeId}:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      });
      catalogCache.set(key, entry);
    }
    return entry;
  };

  const getPrices = (
    accountId: string,
    typeId: string,
    region: string | null,
    sizes: SizeOption[],
  ) => {
    const key = `${accountId} ${typeId} ${region ?? ""}`;
    let entry = priceCache.get(key);
    if (!entry) {
      entry = (async () => {
        const ctx = await getCtx(accountId);
        if (!ctx?.client.getCreateSizePricing) return {};
        return await ctx.client.getCreateSizePricing(typeId, {
          ...(region ? { regionId: region } : {}),
          sizes: sizes.map((s) => ({ id: s.id, vcpus: s.vcpus, memoryMb: s.memoryMb })),
        });
      })().catch((err) => {
        console.error(
          `[rightsizing] size pricing failed for account ${accountId} type ${typeId}:`,
          err instanceof Error ? err.message : err,
        );
        return {};
      });
      priceCache.set(key, entry);
    }
    return entry;
  };

  const groups = new Map<string, OversizedAccountGroup>();

  await Promise.all(
    worthCataloguing.map(async (r) => {
      const entry = declared.get(r.pluginId)!.get(r.resourceTypeId)!;
      const { declaration, typeDef } = entry;
      const fields = asFields(r.fieldsJson) ?? {};
      const currentSizeId = String(fields[declaration.sizeFieldKey] ?? "");
      if (!currentSizeId) return;

      const catalog = await getCatalog(r.accountId, r.resourceTypeId, declaration);
      if (!catalog || catalog.length === 0) return;

      const region = declaration.regionFieldKey
        ? String(fields[declaration.regionFieldKey] ?? "") || null
        : null;
      const priceOverlay = await getPrices(r.accountId, r.resourceTypeId, region, catalog);

      const sizes: RightsizingSizeOption[] = catalog.map((s) => {
        const overlaid = priceOverlay[s.id];
        const priceMonthly = overlaid ?? s.priceMonthly;
        return {
          id: s.id,
          label: s.label,
          vcpus: s.vcpus,
          memoryMb: s.memoryMb,
          ...(s.diskGb !== undefined ? { diskGb: s.diskGb } : {}),
          ...(priceMonthly !== undefined ? { priceMonthly } : {}),
          ...(s.availableFor !== undefined ? { availableFor: s.availableFor } : {}),
        };
      });

      const current = sizes.find((s) => s.id === currentSizeId);
      const utilisation = resolveUtilisation(
        declaration,
        quantilesByResource.get(r.id) ?? [],
        current ? current.memoryMb : null,
      );

      const diskRaw = declaration.diskFieldKey ? Number(fields[declaration.diskFieldKey]) : NaN;
      const recommendation = computeSizeRecommendation({
        currentSizeId,
        sizes,
        utilisation,
        region,
        currentDiskGb: Number.isFinite(diskRaw) && diskRaw > 0 ? diskRaw : null,
        sizeFamilyPattern: declaration.sizeFamilyPattern,
      });
      if (!recommendation) return;

      const account = accountMap.get(r.accountId)!;
      let group = groups.get(r.accountId);
      if (!group) {
        group = {
          accountId: r.accountId,
          accountName: account.displayName,
          pluginId: account.pluginId,
          pluginName: entry.pluginName,
          resources: [],
        };
        groups.set(r.accountId, group);
      }
      group.resources.push({
        id: r.id,
        pluginId: r.pluginId,
        resourceTypeId: r.resourceTypeId,
        resourceTypeName: typeDef.displayName,
        displayName: r.displayName,
        externalId: r.externalId,
        sizeFieldKey: declaration.sizeFieldKey,
        region,
        currentSize: summarize(recommendation.current),
        recommendedSize: summarize(recommendation.recommended),
        cpuP95: round2(utilisation.cpuP95 ?? 0),
        memoryP95: utilisation.memoryP95 !== null ? round2(utilisation.memoryP95) : null,
        memoryMeasured: utilisation.memoryMeasured,
        projectedCpuP95: recommendation.projectedCpuP95,
        currency: declaration.priceCurrency ?? "USD",
        monthlySaving: recommendation.monthlySaving,
        resizeNote: declaration.resizeNote ?? null,
        lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
      } satisfies OversizedResource);
    }),
  );

  const grouped = [...groups.values()].sort((a, b) => a.accountName.localeCompare(b.accountName));
  for (const g of grouped) {
    g.resources.sort(
      (a, b) =>
        a.resourceTypeName.localeCompare(b.resourceTypeName) ||
        a.displayName.localeCompare(b.displayName),
    );
  }

  return {
    accounts: grouped,
    totalCount: grouped.reduce((n, g) => n + g.resources.length, 0),
    windowDays: RIGHTSIZING_WINDOW_DAYS,
    generatedAt,
  };
}

function summarize(size: RightsizingSizeOption): OversizedSizeSummary {
  return {
    id: size.id,
    label: size.label,
    vcpus: size.vcpus,
    memoryMb: size.memoryMb,
    priceMonthly: size.priceMonthly ?? null,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function asFields(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, string | number | boolean>;
}
