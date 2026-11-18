/**
 * The detector: what the org runs (each plugin's `instancePricingUsage` over
 * synced rows), which of those list prices moved in the warehouse lately, and
 * one stored row per change. Runs from the poller (gateway: it calls plugin
 * code) and is the only writer of `price_change_events` apart from the
 * scenario link.
 */
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { priceChangeEvents, resources } from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import {
  lookbackStart,
  matchPriceMoves,
  parsePriceMove,
  usageByPlatform,
  type DetectedPriceChange,
  type PriceMove,
  type UsageEntry,
} from "./match";
import { orgPriceMovesSql, TYPES_PER_QUERY } from "./sql";
import type { WarehouseRows } from "./warehouse";

export type PriceChangeEventRow = typeof priceChangeEvents.$inferSelect;

/** Rows one org query may return; far above any real month of moves for one org's types. */
const MAX_MOVE_ROWS = 10_000;

/** Every running resource's billed instance types, from the plugins that declare them. */
export async function loadOrgUsage(organizationId: string): Promise<UsageEntry[]> {
  const [rows, plugins] = await Promise.all([
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fields: resources.fieldsJson,
        createdAt: resources.createdAt,
        updatedAt: resources.updatedAt,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt))),
    loadPlugins(),
  ]);
  const byId = new Map(plugins.map(({ plugin }) => [plugin.manifest.id, plugin]));
  const entries: UsageEntry[] = [];
  for (const row of rows) {
    const plugin = byId.get(row.pluginId);
    if (!plugin?.instancePricingUsage) continue;
    const instance: ResourceInstance = {
      id: row.id,
      pluginId: row.pluginId,
      resourceTypeId: row.resourceTypeId,
      accountId: row.accountId,
      displayName: row.displayName,
      fields: (row.fields ?? {}) as ResourceInstance["fields"],
      resolvedOutputs: {},
      secretStates: [],
      ...(row.externalId ? { externalId: row.externalId } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
    let usage;
    try {
      usage = plugin.instancePricingUsage(instance);
    } catch (err) {
      // One plugin's bad mapping must not stop the scan for every other resource.
      console.error(`[price-changes] ${row.pluginId} usage for ${row.id} failed:`, err);
      continue;
    }
    for (const u of usage) {
      if (!u.instanceType || !u.region || !(u.units > 0)) continue;
      entries.push({ resourceId: row.id, pluginId: row.pluginId, accountId: row.accountId, usage: u });
    }
  }
  return entries;
}

/** Every move since `since` for the types and regions the entries name. */
export async function readPriceMoves(
  warehouse: WarehouseRows,
  entries: readonly UsageEntry[],
  since: Date,
): Promise<PriceMove[]> {
  const moves: PriceMove[] = [];
  for (const [platform, { types, regions }] of usageByPlatform(entries)) {
    const all = [...types].sort();
    const regionList = [...regions].sort();
    for (let i = 0; i < all.length; i += TYPES_PER_QUERY) {
      const batch = all.slice(i, i + TYPES_PER_QUERY);
      const rows = await warehouse(
        orgPriceMovesSql(platform, batch, regionList, since),
        MAX_MOVE_ROWS,
      );
      for (const row of rows) {
        const move = parsePriceMove(row);
        if (move) moves.push(move);
      }
    }
  }
  return moves;
}

/**
 * Store the detected changes: new ones are inserted, known ones get the
 * current resources and figure (an org that scaled up between scans sees the
 * bigger number), never a second alert. Returns every stored row touched.
 */
export async function storePriceChanges(
  organizationId: string,
  changes: readonly DetectedPriceChange[],
  now: Date,
): Promise<PriceChangeEventRow[]> {
  const out: PriceChangeEventRow[] = [];
  for (const c of changes) {
    const [row] = await db
      .insert(priceChangeEvents)
      .values({
        id: randomUUID(),
        organizationId,
        changeKey: c.changeKey,
        pluginId: c.pluginId,
        platform: c.platform,
        instanceType: c.instanceType,
        region: c.region,
        selection: c.selection,
        oldHourlyUsd: c.oldHourlyUsd,
        newHourlyUsd: c.newHourlyUsd,
        effectiveAt: c.effectiveAt,
        units: c.units,
        approximate: c.approximate,
        monthlyImpactUsd: c.monthlyImpactUsd,
        resources: c.resources,
        detectedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [priceChangeEvents.organizationId, priceChangeEvents.changeKey],
        set: {
          units: c.units,
          approximate: c.approximate,
          monthlyImpactUsd: c.monthlyImpactUsd,
          resources: c.resources,
          updatedAt: now,
        },
      })
      .returning();
    if (row) out.push(row);
  }
  return out;
}

/**
 * One org's scan: usage, moves, match, store. Null when the org runs nothing
 * a plugin can price, so there was nothing to ask the warehouse.
 */
export async function scanOrgPriceChanges(
  organizationId: string,
  warehouse: WarehouseRows,
  now: Date,
): Promise<PriceChangeEventRow[]> {
  const entries = await loadOrgUsage(organizationId);
  if (entries.length === 0) return [];
  const moves = await readPriceMoves(warehouse, entries, lookbackStart(now));
  if (moves.length === 0) return [];
  return storePriceChanges(organizationId, matchPriceMoves(moves, entries), now);
}
