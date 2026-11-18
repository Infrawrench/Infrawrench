/**
 * Reads for the price-change surfaces: the org's stored changes with names
 * resolved (the API, the CLI, the digest), and every change in the catalog
 * for one platform (the Price catalog tab's Changes view). Both run on the
 * edge: Postgres through `db`, the warehouse over HTTPS, no plugin code.
 */
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import {
  instancePricingPageUrl,
  priceChangeCrossesThreshold,
  priceChangePercent,
  PRICE_CHANGE_LIMITS,
  type CatalogPriceChange,
  type CatalogPriceChangeResponse,
  type PriceChange,
  type PriceChangeListResponse,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, costScenarioModels, priceChangeEvents, resources } from "../db/schema";
import { getPriceChangeSettings } from "./settings";
import { catalogPriceMovesSql, WAREHOUSE_PLATFORMS_SQL } from "./sql";
import { priceWarehouse, type WarehouseRows } from "./warehouse";
import type { PriceChangeEventRow } from "./detect";

/** Most changes the org list returns. */
const MAX_ORG_CHANGES = 500;
/** Most changes the catalog list returns. */
const MAX_CATALOG_CHANGES = 1000;
/** Resources named per change; the count and the figure still cover all of them. */
const MAX_RESOURCES_PER_CHANGE = 50;

/** A stored change as the API returns it, given names for its resources. */
export function toPriceChange(
  row: PriceChangeEventRow,
  names: {
    resource: ReadonlyMap<string, { displayName: string; resourceTypeId: string }>;
    account: ReadonlyMap<string, string>;
    scenarioIds: ReadonlySet<string>;
  },
  thresholds: { minMonthlyImpactCents: number; minPercent: number },
  now: Date,
): PriceChange {
  const percent = priceChangePercent(row.oldHourlyUsd, row.newHourlyUsd);
  return {
    id: row.id,
    pluginId: row.pluginId,
    platform: row.platform,
    instanceType: row.instanceType,
    region: row.region,
    selection: row.selection,
    oldHourlyUsd: row.oldHourlyUsd,
    newHourlyUsd: row.newHourlyUsd,
    percent,
    effectiveAt: row.effectiveAt.toISOString(),
    upcoming: row.effectiveAt.getTime() > now.getTime(),
    units: row.units,
    approximate: row.approximate,
    monthlyImpactUsd: row.monthlyImpactUsd,
    resources: row.resources.slice(0, MAX_RESOURCES_PER_CHANGE).map((r) => {
      const res = names.resource.get(r.resourceId);
      return {
        resourceId: r.resourceId,
        displayName: res?.displayName ?? r.resourceId,
        resourceTypeId: res?.resourceTypeId ?? "",
        accountId: r.accountId,
        accountName: names.account.get(r.accountId) ?? "",
        units: r.units,
        approximate: r.approximate,
      };
    }),
    belowThreshold: !priceChangeCrossesThreshold(
      { monthlyImpactUsd: row.monthlyImpactUsd, percent },
      thresholds,
    ),
    alertedAt: row.alertedAt ? row.alertedAt.toISOString() : null,
    suppressionIds: row.suppressionIds,
    scenarioModelId:
      row.scenarioModelId && names.scenarioIds.has(row.scenarioModelId)
        ? row.scenarioModelId
        : null,
    detectedAt: row.detectedAt.toISOString(),
    pageUrl: instancePricingPageUrl(row.platform, row.instanceType, row.region),
  };
}

/** Resolve resource, account and scenario names for a set of stored changes. */
export async function namePriceChanges(
  organizationId: string,
  rows: readonly PriceChangeEventRow[],
  now: Date,
  thresholds: { minMonthlyImpactCents: number; minPercent: number },
): Promise<PriceChange[]> {
  const resourceIds = [
    ...new Set(
      rows.flatMap((r) => r.resources.slice(0, MAX_RESOURCES_PER_CHANGE).map((x) => x.resourceId)),
    ),
  ];
  const scenarioIds = [
    ...new Set(rows.map((r) => r.scenarioModelId).filter((id): id is string => !!id)),
  ];
  const [resourceRows, accountRows, scenarioRows] = await Promise.all([
    resourceIds.length === 0
      ? []
      : db
          .select({
            id: resources.id,
            displayName: resources.displayName,
            resourceTypeId: resources.resourceTypeId,
          })
          .from(resources)
          .where(
            and(eq(resources.organizationId, organizationId), inArray(resources.id, resourceIds)),
          ),
    db
      .select({ id: accounts.id, displayName: accounts.displayName })
      .from(accounts)
      .where(eq(accounts.organizationId, organizationId)),
    scenarioIds.length === 0
      ? []
      : db
          .select({ id: costScenarioModels.id })
          .from(costScenarioModels)
          .where(
            and(
              eq(costScenarioModels.organizationId, organizationId),
              inArray(costScenarioModels.id, scenarioIds),
              isNull(costScenarioModels.deletedAt),
            ),
          ),
  ]);
  const names = {
    resource: new Map(resourceRows.map((r) => [r.id, r])),
    account: new Map(accountRows.map((a) => [a.id, a.displayName])),
    scenarioIds: new Set(scenarioRows.map((s) => s.id)),
  };
  return rows.map((row) => toPriceChange(row, names, thresholds, now));
}

/** The org's changes that took (or take) effect within `days`, newest first. */
export async function listPriceChanges(
  organizationId: string,
  opts: { days?: number; now?: Date } = {},
): Promise<PriceChangeListResponse> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? PRICE_CHANGE_LIMITS.listDays.default;
  const since = new Date(now.getTime() - days * 86_400_000);
  const settings = await getPriceChangeSettings(organizationId);
  const rows = await db
    .select()
    .from(priceChangeEvents)
    .where(
      and(
        eq(priceChangeEvents.organizationId, organizationId),
        gte(priceChangeEvents.effectiveAt, since),
      ),
    )
    .orderBy(desc(priceChangeEvents.effectiveAt))
    .limit(MAX_ORG_CHANGES);
  return {
    changes: await namePriceChanges(organizationId, rows, now, settings),
    available: priceWarehouse() !== null,
    lastScannedAt: settings.lastNotifiedAt ? settings.lastNotifiedAt.toISOString() : null,
    minMonthlyImpactCents: settings.minMonthlyImpactCents,
    minPercent: settings.minPercent,
  };
}

/** One stored change by id, named; null when it is not this org's. */
export async function getPriceChange(
  organizationId: string,
  id: string,
  now = new Date(),
): Promise<PriceChange | null> {
  const [row] = await db
    .select()
    .from(priceChangeEvents)
    .where(and(eq(priceChangeEvents.organizationId, organizationId), eq(priceChangeEvents.id, id)))
    .limit(1);
  if (!row) return null;
  const settings = await getPriceChangeSettings(organizationId);
  const [change] = await namePriceChanges(organizationId, [row], now, settings);
  return change ?? null;
}

// --- The catalog-wide list ---

/** Catalog reads are public data and slow to compute; an hour is fresher than the sync. */
const CATALOG_CACHE_MS = 60 * 60_000;
const CATALOG_CACHE_MAX = 64;
const catalogCache = new Map<string, { at: number; value: Promise<CatalogPriceChangeResponse> }>();

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function readCatalog(
  warehouse: WarehouseRows,
  platform: string,
  days: number,
  now: Date,
): Promise<CatalogPriceChangeResponse> {
  const platforms = (await warehouse(WAREHOUSE_PLATFORMS_SQL, 500))
    .map((r) => String(r["platform"] ?? ""))
    .filter(Boolean);
  const chosen = platforms.includes(platform) ? platform : (platforms[0] ?? platform);
  const since = new Date(now.getTime() - days * 86_400_000);
  const rows = await warehouse(
    catalogPriceMovesSql(chosen, since, MAX_CATALOG_CHANGES + 1),
    MAX_CATALOG_CHANGES + 1,
  );
  const changes: CatalogPriceChange[] = [];
  for (const r of rows.slice(0, MAX_CATALOG_CHANGES)) {
    const oldUsd = num(r["old_usd"]);
    const newUsd = num(r["new_usd"]);
    const at = num(r["effective_at"]);
    if (oldUsd === null || newUsd === null || at === null) continue;
    const instanceType = String(r["instance_type"] ?? "");
    const region = String(r["region"] ?? "");
    changes.push({
      platform: chosen,
      instanceType,
      region,
      variant: String(r["variant_text"] ?? ""),
      oldHourlyUsd: oldUsd,
      newHourlyUsd: newUsd,
      percent: priceChangePercent(oldUsd, newUsd),
      effectiveAt: new Date(at * 1000).toISOString(),
      vcpu: num(r["vcpu"]),
      memoryGib: num(r["memory_gib"]),
      pageUrl: instancePricingPageUrl(chosen, instanceType, region),
    });
  }
  return {
    available: true,
    platforms,
    platform: chosen,
    days,
    changes,
    truncated: rows.length > MAX_CATALOG_CHANGES,
  };
}

/**
 * Every headline list-price change on one platform over the last `days`,
 * from the warehouse, cached for an hour per (platform, days). A failed read
 * is not cached.
 */
export async function listCatalogPriceChanges(
  opts: { platform?: string; days?: number; now?: Date } = {},
  warehouse: WarehouseRows | null = priceWarehouse(),
): Promise<CatalogPriceChangeResponse> {
  const { min, max, default: fallback } = PRICE_CHANGE_LIMITS.catalogDays;
  const days = Math.min(max, Math.max(min, Math.floor(opts.days ?? fallback)));
  const platform = opts.platform ?? "ec2";
  if (!warehouse) {
    return { available: false, platforms: [], platform, days, changes: [], truncated: false };
  }
  const now = opts.now ?? new Date();
  const key = `${platform}|${days}`;
  const held = catalogCache.get(key);
  if (held && now.getTime() - held.at < CATALOG_CACHE_MS) return held.value;
  const value = readCatalog(warehouse, platform, days, now);
  catalogCache.set(key, { at: now.getTime(), value });
  if (catalogCache.size > CATALOG_CACHE_MAX) {
    const oldest = catalogCache.keys().next().value;
    if (oldest !== undefined) catalogCache.delete(oldest);
  }
  value.catch(() => {
    if (catalogCache.get(key)?.value === value) catalogCache.delete(key);
  });
  return value;
}
