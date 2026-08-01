/**
 * The status-feed collection pass: fetch each declared provider status feed,
 * hand the body to the plugin's `parseStatusFeed`, cache the normalized
 * incidents in Postgres, and fan out notifications for new overlaps.
 *
 * Claiming follows `poller/src/claim.ts` exactly: one
 * `UPDATE … WHERE plugin_id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`
 * statement per tick, with the lease written into `next_fetch_at` itself, so
 * any number of poller replicas share the work without double-fetching.
 *
 * Failure visibility is load-bearing (poller errors are otherwise invisible):
 * every fetch/parse failure is both logged with the plugin id + URL *and*
 * persisted to `provider_status_feeds.last_status`/`last_error`, with an
 * exponential backoff so a dead feed doesn't get hammered. A failure never
 * silently reports "no incidents" — the previous cache stays as-is.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { StatusIncident } from "@infrawrench/plugin-base";
import { db } from "../db/client.js";
import { providerStatusFeeds, providerStatusIncidents } from "../db/schema.js";
import { loadPlugins, type LoadedPlugin } from "../plugin-loader.js";
import { fetchStatusFeedBody } from "./fetch-feed.js";
import { notifyOrgsOfIncidents } from "./notify.js";

/** Cadence between successful fetches of one feed. Feeds cache ~10-60s
 * upstream, and incident latency of a few minutes is fine for a banner. */
const SUCCESS_INTERVAL_MS = 3 * 60 * 1000;

/** Lease while a fetch is in flight — generous vs. the 20s fetch timeout. */
const FEED_LEASE_MS = 5 * 60 * 1000;

/** Feeds fetched per tick across all replicas (each fetch is one HTTP GET). */
const FEEDS_PER_TICK = 6;

/** Don't backfill incidents that resolved long before we started watching. */
const RESOLVED_BACKFILL_CUTOFF_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_ERROR_LENGTH = 500;

/** Plugins whose manifest declares a feed *and* that ship the parser. */
async function statusFeedPlugins(): Promise<LoadedPlugin[]> {
  const loaded = await loadPlugins();
  return loaded.filter(
    (p) => p.plugin.manifest.statusFeed && typeof p.plugin.parseStatusFeed === "function",
  );
}

/**
 * Run one collection tick: ensure a feed row exists per capable plugin,
 * claim the due ones, and collect each. Individual feed failures are
 * contained — one broken provider never blocks the rest.
 */
export async function runStatusFeedCollection(limit = FEEDS_PER_TICK): Promise<void> {
  const capable = await statusFeedPlugins();
  if (capable.length === 0) return;
  const byId = new Map(capable.map((p) => [p.plugin.manifest.id, p]));
  const ids = Array.from(byId.keys());

  await db
    .insert(providerStatusFeeds)
    .values(ids.map((pluginId) => ({ pluginId })))
    .onConflictDoNothing({ target: providerStatusFeeds.pluginId });

  const claimed = await claimDueFeeds(ids, limit);
  for (const pluginId of claimed) {
    const plugin = byId.get(pluginId);
    if (!plugin) continue; // Row for a plugin since removed from the registry.
    await collectOneFeed(plugin);
  }
}

/** Same shape as `claimDueAccounts` — see `poller/src/claim.ts`. */
async function claimDueFeeds(pluginIds: string[], limit: number): Promise<string[]> {
  const rows = await db.execute(sql`
    UPDATE provider_status_feeds
    SET next_fetch_at = now() + ${FEED_LEASE_MS}::float8 * interval '1 millisecond',
        updated_at = now()
    WHERE plugin_id IN (
      SELECT plugin_id FROM provider_status_feeds
      -- IN, not = ANY(): the sql tag expands a JS array into a parenthesized
      -- placeholder list, which is what IN takes (see poller/src/claim.ts).
      WHERE plugin_id IN ${pluginIds}
        AND (next_fetch_at IS NULL OR next_fetch_at <= now())
      ORDER BY last_fetched_at ASC NULLS FIRST, plugin_id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING plugin_id
  `);
  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => String(r["plugin_id"]));
}

async function collectOneFeed(loaded: LoadedPlugin): Promise<void> {
  const manifest = loaded.plugin.manifest;
  const feed = manifest.statusFeed;
  const parse = loaded.plugin.parseStatusFeed;
  if (!feed || !parse) return;
  const fetchStart = new Date();
  try {
    const body = await fetchStatusFeedBody(feed.url);
    const incidents = parse.call(loaded.plugin, body);
    await upsertIncidents(manifest.id, incidents, fetchStart);
    await closeStaleIncidents(manifest.id, fetchStart);
    await db
      .update(providerStatusFeeds)
      .set({
        lastFetchedAt: fetchStart,
        lastStatus: "ok",
        lastError: null,
        failureCount: 0,
        nextFetchAt: new Date(Date.now() + SUCCESS_INTERVAL_MS),
        updatedAt: new Date(),
      })
      .where(eq(providerStatusFeeds.pluginId, manifest.id));
    await notifyOrgsOfIncidents(manifest.id);
  } catch (err) {
    // Both halves matter: the log line is what an operator tails, the row is
    // what a UI can read. Backoff doubles per consecutive failure, capped at
    // 30 minutes, so a provider that kills its feed costs almost nothing.
    console.error(`[poller] status feed for ${manifest.id} (${feed.url}) failed:`, err);
    const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
    await db
      .update(providerStatusFeeds)
      .set({
        lastFetchedAt: fetchStart,
        lastStatus: "error",
        lastError: message,
        failureCount: sql`${providerStatusFeeds.failureCount} + 1`,
        nextFetchAt: sql`now() + least(
          interval '30 minutes',
          ${SUCCESS_INTERVAL_MS}::float8 * interval '1 millisecond'
            * power(2, least(${providerStatusFeeds.failureCount}, 5))
        )`,
        updatedAt: new Date(),
      })
      .where(eq(providerStatusFeeds.pluginId, manifest.id));
  }
}

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

async function upsertIncidents(
  pluginId: string,
  incidents: StatusIncident[],
  seenAt: Date,
): Promise<void> {
  const backfillCutoff = new Date(seenAt.getTime() - RESOLVED_BACKFILL_CUTOFF_MS);
  for (const incident of incidents) {
    const resolvedAt = incident.resolvedAt ? parseDate(incident.resolvedAt, seenAt) : null;
    // Feeds like incident.io's incidents.json carry full history; don't
    // backfill rows for incidents that resolved long before we watched.
    if (resolvedAt && resolvedAt < backfillCutoff) continue;
    const values = {
      title: incident.title.slice(0, 500),
      state: incident.state,
      impact: incident.impact,
      url: incident.url ?? null,
      startedAt: parseDate(incident.startedAt, seenAt),
      resolvedAt,
      lastUpdateAt: incident.lastUpdateAt ? parseDate(incident.lastUpdateAt, seenAt) : null,
      lastUpdateText: incident.lastUpdateText ? incident.lastUpdateText.slice(0, 2000) : null,
      regions: incident.regions,
      services: incident.services,
      resourceTypeIds: incident.resourceTypes ?? [],
      providerWide: incident.providerWide ?? false,
      lastSeenAt: seenAt,
      updatedAt: new Date(),
    };
    await db
      .insert(providerStatusIncidents)
      .values({ id: randomUUID(), pluginId, externalId: incident.externalId, ...values })
      .onConflictDoUpdate({
        target: [providerStatusIncidents.pluginId, providerStatusIncidents.externalId],
        set: values,
      });
  }
}

/**
 * Feeds like Statuspage's `unresolved.json` simply drop resolved incidents;
 * any active row this fetch didn't touch is therefore over.
 */
async function closeStaleIncidents(pluginId: string, fetchStart: Date): Promise<void> {
  await db
    .update(providerStatusIncidents)
    .set({ resolvedAt: fetchStart, state: "resolved", updatedAt: new Date() })
    .where(
      and(
        eq(providerStatusIncidents.pluginId, pluginId),
        isNull(providerStatusIncidents.resolvedAt),
        lt(providerStatusIncidents.lastSeenAt, fetchStart),
      ),
    );
}
