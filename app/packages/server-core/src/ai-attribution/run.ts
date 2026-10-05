/**
 * One attribution run: read an org-day's billed AI rows and its latest request
 * aggregates, split the bill (`attribute.ts`), write the split at a fresh
 * `run_at` and record the day's match statistics.
 *
 * Runs after every source collection (for the days it collected) and after
 * every cost collection of an org with sources (for the restatement window),
 * so a restated bill is re-split the same day it lands. Cheap: two
 * single-partition ClickHouse reads and one insert per day.
 */
import type { AiModelRateCard } from "@infrawrench/plugin-base";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/client";
import {
  aiAttributionDays,
  aiAttributionDimensions,
  aiRequestSources,
  type AiAttributionDayCollection,
  type AiAttributionDaySourceStats,
} from "../db/schema";
import { isClickHouseConfigured } from "../clickhouse/client";
import {
  insertAttributedRows,
  readBilledAiRows,
  readLatestAiAggregates,
} from "../clickhouse/ai-attribution-store";
import { loadPlugins } from "../plugin-loader";
import { attributeDay } from "./attribute";

let cachedRateCards: Map<string, AiModelRateCard> | null = null;

/** Every plugin-declared rate card, by canonical provider id. */
export async function loadAiRateCards(): Promise<Map<string, AiModelRateCard>> {
  if (cachedRateCards) return cachedRateCards;
  const map = new Map<string, AiModelRateCard>();
  for (const { plugin } of await loadPlugins()) {
    const card = plugin.manifest.aiModelRates;
    if (card) map.set(card.provider, card);
  }
  cachedRateCards = map;
  return map;
}

/** Whether an org has any request-log source at all (cheap gate for the cost hook). */
export async function orgHasAiSources(organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: aiRequestSources.id })
    .from(aiRequestSources)
    .where(eq(aiRequestSources.organizationId, organizationId))
    .limit(1);
  return !!row;
}

/** Record how a source's collection of a day went, ahead of (or between) runs. */
export async function recordAiCollection(
  organizationId: string,
  day: string,
  sourceId: string,
  info: AiAttributionDayCollection,
): Promise<void> {
  const patch = JSON.stringify({ [sourceId]: info });
  await db
    .insert(aiAttributionDays)
    .values({ organizationId, day, collections: { [sourceId]: info } })
    .onConflictDoUpdate({
      target: [aiAttributionDays.organizationId, aiAttributionDays.day],
      set: { collections: sql`${aiAttributionDays.collections} || ${patch}::jsonb` },
    });
}

/** Re-split one org-day. Returns the number of split rows written. */
export async function attributeOrgDay(organizationId: string, day: string): Promise<number> {
  if (!isClickHouseConfigured()) return 0;
  const [dimensions, sources] = await Promise.all([
    db
      .select({
        key: aiAttributionDimensions.key,
        metadataKeys: aiAttributionDimensions.metadataKeys,
      })
      .from(aiAttributionDimensions)
      .where(eq(aiAttributionDimensions.organizationId, organizationId)),
    db
      .select({ id: aiRequestSources.id })
      .from(aiRequestSources)
      .where(
        and(
          eq(aiRequestSources.organizationId, organizationId),
          eq(aiRequestSources.enabled, true),
        ),
      ),
  ]);
  const [billed, aggregates, rateCards] = await Promise.all([
    readBilledAiRows(organizationId, day),
    readLatestAiAggregates(
      organizationId,
      day,
      sources.map((s) => s.id),
    ),
    loadAiRateCards(),
  ]);
  const result = attributeDay(
    billed,
    aggregates,
    dimensions.map((d) => ({ key: d.key, metadataKeys: d.metadataKeys ?? [] })),
    rateCards,
  );
  const runAt = new Date();
  await insertAttributedRows(organizationId, runAt.toISOString(), result.rows);

  const [existing] = await db
    .select({ collections: aiAttributionDays.collections })
    .from(aiAttributionDays)
    .where(
      and(eq(aiAttributionDays.organizationId, organizationId), eq(aiAttributionDays.day, day)),
    );
  const collections = existing?.collections ?? {};
  const sourceStats: Record<string, AiAttributionDaySourceStats> = {};
  for (const s of sources) {
    const st = result.sources[s.id];
    const col = collections[s.id];
    if (!st && !col) continue;
    sourceStats[s.id] = {
      requests: st?.requests ?? 0,
      matchedRequests: st?.matchedRequests ?? 0,
      ambiguousRequests: st?.ambiguousRequests ?? 0,
      unmatchedRequests: st?.unmatchedRequests ?? 0,
      skippedRecords: col?.skipped ?? 0,
      degraded: col?.degraded ?? false,
      truncated: col?.truncated ?? false,
      attributed: st?.attributed ?? {},
      billed: st?.billed ?? {},
    };
  }
  await db
    .insert(aiAttributionDays)
    .values({ organizationId, day, runAt, sources: sourceStats, providers: result.providers })
    .onConflictDoUpdate({
      target: [aiAttributionDays.organizationId, aiAttributionDays.day],
      set: { runAt, sources: sourceStats, providers: result.providers },
    });
  return result.rows.length;
}

/** Re-split several days, oldest first. Errors on one day do not stop the rest. */
export async function attributeOrgDays(organizationId: string, days: string[]): Promise<void> {
  for (const day of [...new Set(days)].sort()) {
    try {
      await attributeOrgDay(organizationId, day);
    } catch (err) {
      console.error(`[ai-attribution] run for ${organizationId} ${day} failed:`, err);
    }
  }
}

const recentRuns = new Map<string, number>();
const COST_HOOK_MIN_INTERVAL_MS = 30 * 60 * 1000;
const COST_HOOK_DAYS = 4;

/**
 * Called after an account's cost collection: re-split the trailing days a
 * provider may have restated, for orgs that have sources. Rate-limited per
 * org in process, because a many-account org collects one account at a time.
 * Never throws: it rides on a collection that already succeeded.
 */
export async function reattributeAfterCostCollection(organizationId: string): Promise<void> {
  try {
    const last = recentRuns.get(organizationId) ?? 0;
    if (Date.now() - last < COST_HOOK_MIN_INTERVAL_MS) return;
    if (!(await orgHasAiSources(organizationId))) return;
    recentRuns.set(organizationId, Date.now());
    const days: string[] = [];
    for (let i = 1; i <= COST_HOOK_DAYS; i++) {
      days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
    }
    await attributeOrgDays(organizationId, days);
  } catch (err) {
    console.error(`[ai-attribution] post-cost re-attribution for ${organizationId} failed:`, err);
  }
}
