/**
 * The poller pass that processes virtual tags: evaluates each due tag over the
 * org's stored cost history (the backfill) and records what it found.
 *
 * Queries never wait on this. Virtual tags compile into every read at query
 * time, so a saved edit already answers every graph, budget and export the
 * moment it is stored. What this pass adds is the *account* of the edit: how
 * much spend each rule claims, how much nothing matches, which values came
 * out, how many days a metric split had to fall back, and whether the rules
 * still evaluate at all (a referenced business metric that was deleted, a
 * stored filter that no longer parses). That is the status badge and the
 * coverage numbers in Settings.
 *
 * Claim protocol: the one every claimed pass uses (see `poller/src/claim.ts`).
 * `next_process_at` doubles as the lease; saving a tag sets it to now. A
 * processed tag is refreshed every {@link VIRTUAL_TAG_REFRESH_MS} so the stats
 * follow newly collected spend and newly reported metric values.
 */
import { sql } from "drizzle-orm";
import {
  normalizeVirtualTagInput,
  virtualTagInputError,
  virtualTagMetricIds,
  type VirtualTag,
  type VirtualTagInput,
  type VirtualTagCurrencyStats,
  type VirtualTagRule,
  type VirtualTagStats,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { getOrgCostDayRange, getVirtualTagStats } from "../clickhouse/cost-readers";
import { VirtualTagError, compileVirtualTagForRange, loadMetricValues } from "./virtual-tags";

/** Longer than the worst-case evaluation: three aggregates over the history. */
export const VIRTUAL_TAG_LEASE_MS = 10 * 60 * 1000;

/** How often a processed tag is re-evaluated without anybody editing it. */
export const VIRTUAL_TAG_REFRESH_MS = 12 * 60 * 60 * 1000;

/** Back-off after a failed evaluation. */
export const VIRTUAL_TAG_RETRY_MS = 60 * 60 * 1000;

/** Bounded like the read path: the same 1,100-day ceiling `runCostQuery` enforces. */
export const VIRTUAL_TAG_MAX_HISTORY_DAYS = 1100;

export const VIRTUAL_TAGS_PER_TICK = 4;

interface ClaimedTag {
  id: string;
  organizationId: string;
  key: string;
  defaultValue: string | null;
  rules: VirtualTagRule[];
  /**
   * `updated_at` as Postgres' own text, not a `Date`: the column carries
   * microseconds a JS `Date` would drop, and the completion guard compares it
   * for equality.
   */
  updatedAt: string;
}

export async function claimDueVirtualTags(limit: number): Promise<ClaimedTag[]> {
  const rows = await db.execute(sql`
    UPDATE virtual_tags
    SET next_process_at = now() + ${VIRTUAL_TAG_LEASE_MS}::float8 * interval '1 millisecond',
        processing_state = 'processing'
    WHERE id IN (
      SELECT id FROM virtual_tags
      WHERE next_process_at IS NOT NULL
        AND next_process_at <= now()
      ORDER BY next_process_at ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, organization_id, key, default_value, rules, updated_at::text AS updated_at
  `);
  return Array.from(rows as Iterable<Record<string, unknown>>, (r) => ({
    id: String(r["id"]),
    organizationId: String(r["organization_id"]),
    key: String(r["key"]),
    defaultValue: (r["default_value"] as string | null) ?? null,
    rules: (r["rules"] as VirtualTagRule[] | null) ?? [],
    updatedAt: String(r["updated_at"]),
  }));
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Evaluate one tag over the stored history. Pure orchestration over the
 * readers, exported for the tests.
 */
export async function evaluateVirtualTag(
  organizationId: string,
  tag: Pick<VirtualTag, "key" | "defaultValue" | "rules">,
  opts: { days?: number } = {},
): Promise<VirtualTagStats> {
  const range = await getOrgCostDayRange(organizationId);
  if (!range) {
    return { from: null, to: null, currencies: [], metricFallbackDays: 0, distinctValues: 0 };
  }
  const days = Math.min(opts.days ?? VIRTUAL_TAG_MAX_HISTORY_DAYS, VIRTUAL_TAG_MAX_HISTORY_DAYS);
  const earliest = addDays(range.lastDay, -(days - 1));
  const from = range.firstDay > earliest ? range.firstDay : earliest;
  const to = range.lastDay;

  const metricIds = virtualTagMetricIds(tag.rules);
  // A metric with no values in the window is not an error: its split runs on
  // equal shares, and `metricFallbackDays` is what tells the owner so.
  const metricValues = await loadMetricValues(organizationId, metricIds, from, to);
  const { compiled, metricFallbackDays } = compileVirtualTagForRange(tag, metricValues, from, to);
  const rows = await getVirtualTagStats(organizationId, compiled, from, to);

  const byCurrency = new Map<string, VirtualTagCurrencyStats>();
  const entry = (currency: string): VirtualTagCurrencyStats => {
    let e = byCurrency.get(currency);
    if (!e) {
      e = {
        currency,
        total: 0,
        unmatched: 0,
        byRule: tag.rules.map(() => 0),
        topValues: [],
      };
      byCurrency.set(currency, e);
    }
    return e;
  };
  for (const r of rows.byRule) {
    const e = entry(r.currency);
    e.total += r.amount;
    if (r.rule === 0) e.unmatched += r.amount;
    else if (r.rule - 1 < e.byRule.length) e.byRule[r.rule - 1]! += r.amount;
  }
  for (const r of rows.topValues) {
    const e = entry(r.currency);
    if (e.topValues.length < 10) e.topValues.push({ value: r.value, amount: r.amount });
  }

  return {
    from,
    to,
    currencies: [...byCurrency.values()].sort((a, b) => b.total - a.total),
    metricFallbackDays,
    distinctValues: rows.distinctValues,
  };
}

/**
 * Record an outcome, unless the tag was edited while it was being evaluated:
 * that edit re-queued it (`updated_at` moved), and stats for the old rules must
 * not overwrite the "Queued" state the edit set.
 */
async function recordOutcome(
  tag: ClaimedTag,
  outcome: { stats: VirtualTagStats } | { error: string },
): Promise<void> {
  if ("stats" in outcome) {
    await db.execute(sql`
      UPDATE virtual_tags
      SET processing_state = 'ready',
          processed_at = now(),
          processing_error = NULL,
          stats = ${JSON.stringify(outcome.stats)}::jsonb,
          next_process_at = now() + ${VIRTUAL_TAG_REFRESH_MS}::float8 * interval '1 millisecond'
      WHERE id = ${tag.id}
        AND updated_at = ${tag.updatedAt}::timestamp
    `);
    return;
  }
  // A failure keeps the last good stats: they still describe the rules as of
  // the last successful evaluation, and the error says why they are stale.
  await db.execute(sql`
    UPDATE virtual_tags
    SET processing_state = 'failed',
        processed_at = now(),
        processing_error = ${outcome.error},
        next_process_at = now() + ${VIRTUAL_TAG_RETRY_MS}::float8 * interval '1 millisecond'
    WHERE id = ${tag.id}
      AND updated_at = ${tag.updatedAt}::timestamp
  `);
}

export async function processVirtualTag(tag: ClaimedTag): Promise<void> {
  try {
    const stats = await evaluateVirtualTag(tag.organizationId, tag);
    await recordOutcome(tag, { stats });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[virtual-tags] evaluating ${tag.key} (${tag.id}) failed:`, message);
    await recordOutcome(tag, { error: message.slice(0, 2000) });
  }
}

/** How far back an unsaved definition is previewed. */
export const VIRTUAL_TAG_PREVIEW_DAYS = 30;

/**
 * Evaluate an unsaved definition over the trailing
 * {@link VIRTUAL_TAG_PREVIEW_DAYS} days of stored spend: what the editor shows
 * before anything is saved. Validates exactly as a save would, so a preview
 * can never succeed for rules the save then refuses.
 */
export async function previewVirtualTag(
  organizationId: string,
  input: VirtualTagInput,
): Promise<VirtualTagStats> {
  const normalized = normalizeVirtualTagInput(input);
  const error = virtualTagInputError(normalized);
  if (error) throw new VirtualTagError(error);
  return evaluateVirtualTag(
    organizationId,
    { key: normalized.key, defaultValue: normalized.defaultValue ?? null, rules: normalized.rules },
    { days: VIRTUAL_TAG_PREVIEW_DAYS },
  );
}

export async function runVirtualTagPass(opts: { limit?: number } = {}): Promise<void> {
  const claimed = await claimDueVirtualTags(opts.limit ?? VIRTUAL_TAGS_PER_TICK);
  if (claimed.length === 0) return;
  await Promise.allSettled(claimed.map((tag) => processVirtualTag(tag)));
}
