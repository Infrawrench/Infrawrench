/**
 * The poller pass that collects AI request-log sources.
 *
 * The cost-exports claim protocol: one conditional `UPDATE … WHERE id IN
 * (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`, with `next_run_at` doubling as
 * the lease, so replicas never collect the same source at once and a replica
 * that dies simply lets the lease lapse.
 *
 * Collection is **forward-only**, like network flows: request logs do not
 * restate, so each closed UTC day is read once and the watermark moves past
 * it. A day is only read once it has settled ({@link SETTLE_MS} after its
 * end), because S3 delivery and gateway log indexing lag by minutes to hours.
 * Re-reading history is an explicit act (`recollectAiRequestSource`).
 */
import { AiRequestLogSetupError } from "@infrawrench/plugin-base";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/client";
import { aiAttributionDimensions, aiRequestSources } from "../db/schema";
import { insertAiRequestAggregates } from "../clickhouse/ai-attribution-store";
import { loadAccountClient } from "../sync-resources";
import { fetchLiteLlmDay } from "./litellm";
import { loadAiSourceApiKey, type AiRequestSourceRow } from "./store";
import { attributeOrgDays, recordAiCollection } from "./run";

export const AI_SOURCE_LEASE_MS = 30 * 60 * 1000;
export const AI_SOURCES_PER_TICK = 2;
/** Most days one pass reads before yielding; the rest come due right after. */
export const AI_MAX_DAYS_PER_PASS = 7;
/** How long after a day ends before it is considered complete at the source. */
export const SETTLE_MS = 3 * 60 * 60 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const BASE_BACKOFF_MS = 60 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const SETUP_BACKOFF_MS = 12 * 60 * 60 * 1000;

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** The closed, settled days a source should read next, oldest first. */
export function daysToCollect(
  collectedThrough: string | null,
  lookbackDays: number,
  maxHistoryDays: number,
  now: Date,
  limit = AI_MAX_DAYS_PER_PASS,
): string[] {
  const lastSettled = new Date(now.getTime() - SETTLE_MS - 86_400_000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const oldestAllowed = addDays(today, -Math.max(1, maxHistoryDays));
  let start = collectedThrough ? addDays(collectedThrough, 1) : addDays(today, -lookbackDays);
  if (start < oldestAllowed) start = oldestAllowed;
  const days: string[] = [];
  for (let d = start; d <= lastSettled && days.length < limit; d = addDays(d, 1)) days.push(d);
  return days;
}

export async function claimDueAiSources(limit: number): Promise<AiRequestSourceRow[]> {
  const rows = await db.execute(sql`
    UPDATE ai_request_sources
    SET next_run_at = now() + ${AI_SOURCE_LEASE_MS}::float8 * interval '1 millisecond'
    WHERE id IN (
      SELECT id FROM ai_request_sources
      WHERE enabled = true
        AND next_run_at IS NOT NULL
        AND next_run_at <= now()
      ORDER BY next_run_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `);
  const ids = Array.from(rows as Iterable<Record<string, unknown>>, (r) => String(r["id"]));
  if (ids.length === 0) return [];
  const out: AiRequestSourceRow[] = [];
  for (const id of ids) {
    const [row] = await db.select().from(aiRequestSources).where(eq(aiRequestSources.id, id));
    if (row) out.push(row);
  }
  return out;
}

/** Collect one source's due days. Records its own outcome; never throws. */
export async function runAiSource(row: AiRequestSourceRow): Promise<void> {
  const collected: string[] = [];
  try {
    const dims = await db
      .select({ metadataKeys: aiAttributionDimensions.metadataKeys })
      .from(aiAttributionDimensions)
      .where(eq(aiAttributionDimensions.organizationId, row.organizationId));
    const metadataKeys = [...new Set(dims.flatMap((d) => d.metadataKeys ?? []))];

    let maxHistoryDays = 90;
    let fetchDay: (day: string) => ReturnType<typeof fetchLiteLlmDay>;
    if (row.kind === "litellm") {
      const key = await loadAiSourceApiKey(row);
      if (!key || !row.baseUrl)
        throw new AiRequestLogSetupError("The LiteLLM key or URL is missing.");
      fetchDay = (day) => fetchLiteLlmDay(row.baseUrl!, key, day, metadataKeys);
    } else {
      if (!row.accountId) throw new AiRequestLogSetupError("This source's account was removed.");
      const { client, plugin } = await loadAccountClient(row.accountId, row.organizationId);
      const kind = plugin.manifest.aiRequestLogs?.sourceKinds.find(
        (k) => k.id === row.sourceKindId,
      );
      if (!kind || !client.fetchAiRequestLogs) {
        throw new AiRequestLogSetupError(
          `The ${plugin.manifest.displayName} plugin no longer offers this request-log source.`,
        );
      }
      maxHistoryDays = kind.maxHistoryDays;
      const fetchLogs = client.fetchAiRequestLogs.bind(client);
      fetchDay = (day) =>
        fetchLogs(row.accountId!, {
          sourceKindId: row.sourceKindId,
          location: row.location ?? {},
          day,
          metadataKeys,
        });
    }

    const days = daysToCollect(row.collectedThrough, row.lookbackDays, maxHistoryDays, new Date());
    let observed: Record<string, number> = row.observedMetadataKeys ?? {};
    let bytesScanned: number | null = null;
    for (const day of days) {
      const result = await fetchDay(day);
      await insertAiRequestAggregates(
        row.organizationId,
        row.id,
        day,
        new Date().toISOString(),
        result.aggregates,
      );
      await recordAiCollection(row.organizationId, day, row.id, {
        requests: result.requests,
        skipped: result.skipped,
        degraded: result.degraded === true,
        truncated: result.truncated === true,
      });
      if (Object.keys(result.observedMetadataKeys).length > 0)
        observed = result.observedMetadataKeys;
      if (result.queryBytesScanned !== undefined) {
        bytesScanned = (bytesScanned ?? 0) + result.queryBytesScanned;
      }
      collected.push(day);
      await db
        .update(aiRequestSources)
        .set({ collectedThrough: day })
        .where(eq(aiRequestSources.id, row.id));
    }
    const more = days.length >= AI_MAX_DAYS_PER_PASS;
    await db
      .update(aiRequestSources)
      .set({
        lastRunAt: new Date(),
        nextRunAt: new Date(Date.now() + (more ? 60_000 : INTERVAL_MS)),
        failureCount: 0,
        lastError: null,
        lastErrorHelpUrl: null,
        observedMetadataKeys: observed,
        ...(bytesScanned !== null
          ? { lastQueryBytesScanned: Math.min(bytesScanned, 2_147_483_647) }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(aiRequestSources.id, row.id), eq(aiRequestSources.enabled, true)));
  } catch (err) {
    const setup =
      err instanceof Error &&
      (err.name === "AiRequestLogSetupError" || err instanceof AiRequestLogSetupError);
    const failures = row.failureCount + 1;
    const backoff = setup
      ? SETUP_BACKOFF_MS
      : Math.min(BASE_BACKOFF_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
    const message = err instanceof Error ? err.message : String(err);
    const helpUrl =
      setup && typeof (err as { helpUrl?: unknown }).helpUrl === "string"
        ? (err as { helpUrl: string }).helpUrl
        : null;
    console.error(`[ai-attribution] source ${row.id} failed:`, message);
    await db
      .update(aiRequestSources)
      .set({
        lastRunAt: new Date(),
        nextRunAt: new Date(Date.now() + backoff),
        failureCount: failures,
        lastError: message.slice(0, 2000),
        lastErrorHelpUrl: helpUrl && helpUrl.startsWith("https://") ? helpUrl : null,
        updatedAt: new Date(),
      })
      .where(and(eq(aiRequestSources.id, row.id), eq(aiRequestSources.enabled, true)));
  }
  if (collected.length > 0) await attributeOrgDays(row.organizationId, collected);
}

/** One tick: claim a few due sources and collect them concurrently. */
export async function runAiAttributionPass(opts: { limit?: number } = {}): Promise<void> {
  const claimed = await claimDueAiSources(opts.limit ?? AI_SOURCES_PER_TICK);
  if (claimed.length === 0) return;
  await Promise.allSettled(claimed.map((row) => runAiSource(row)));
}

/** Location picker options for a plugin source kind, from the owning account. */
export async function listAiSourceLocations(
  organizationId: string,
  accountId: string,
  sourceKindId: string,
) {
  const { client, plugin } = await loadAccountClient(accountId, organizationId);
  const kind = plugin.manifest.aiRequestLogs?.sourceKinds.find((k) => k.id === sourceKindId);
  if (!kind || !client.listAiRequestLogLocations) return [];
  return client.listAiRequestLogLocations(accountId, sourceKindId);
}
