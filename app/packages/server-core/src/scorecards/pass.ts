/**
 * The poller's scorecard pass: claim orgs whose scorecards are due, score
 * every service, reschedule.
 *
 * `org_scorecard_settings.next_eval_at` is the due column AND the claim
 * lease, the metric-alert protocol: one `UPDATE … WHERE organization_id IN
 * (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`, so replicas share the orgs
 * and a replica that dies mid-pass lets its orgs come due again when the
 * lease expires. Any service or scorecard write sets `next_eval_at` to null,
 * which is "due now", so an edit is scored within a tick.
 *
 * Runtime `gateway`: the posture, orphan and backup feeds evaluate plugin
 * rule declarations against the full plugin registry, which the edge Worker
 * only carries as metadata.
 *
 * Never throws.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { orgScorecardSettings } from "../db/schema";
import { evaluateOrgScorecards } from "./eval";
import { pruneScorecardHistory } from "./store";

/** Must exceed one org's evaluation (a posture scan, an orphan scan, ClickHouse reads). */
export const SCORECARD_LEASE_MS = 15 * 60 * 1000;

/** Scores move with inventory and findings, which change on the sync cadence. */
export const SCORECARD_EVAL_INTERVAL_MS = 60 * 60 * 1000;

export async function claimDueScorecardOrgs(limit: number): Promise<string[]> {
  const claimed = await db.execute(sql`
    UPDATE org_scorecard_settings
    SET next_eval_at = now() + ${SCORECARD_LEASE_MS}::float8 * interval '1 millisecond'
    WHERE organization_id IN (
      SELECT organization_id FROM org_scorecard_settings
      WHERE next_eval_at IS NULL OR next_eval_at <= now()
      ORDER BY last_eval_at ASC NULLS FIRST, organization_id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING organization_id
  `);
  return Array.from(claimed as Iterable<Record<string, unknown>>, (r) =>
    String(r["organization_id"]),
  );
}

async function finish(organizationId: string, now: Date, error: string | null): Promise<void> {
  try {
    await db
      .update(orgScorecardSettings)
      .set({
        nextEvalAt: new Date(now.getTime() + SCORECARD_EVAL_INTERVAL_MS),
        lastEvalAt: now,
        lastError: error,
        updatedAt: now,
      })
      .where(eq(orgScorecardSettings.organizationId, organizationId));
  } catch (err) {
    console.error(`[scorecards] org ${organizationId} reschedule failed:`, err);
  }
}

let lastPrune = 0;

export async function runScorecardPass(
  options: { limit?: number } = {},
): Promise<{ claimed: number }> {
  let claimed: string[];
  try {
    claimed = await claimDueScorecardOrgs(options.limit ?? 5);
  } catch (err) {
    console.error("[scorecards] claim failed:", err);
    return { claimed: 0 };
  }
  // Sequential: each org runs several org-wide scans; fanning them out would
  // multiply the pass's peak memory by the batch size.
  for (const organizationId of claimed) {
    const now = new Date();
    try {
      await evaluateOrgScorecards(organizationId, { now });
      await finish(organizationId, now, null);
    } catch (err) {
      console.error(`[scorecards] org ${organizationId} evaluation failed:`, err);
      await finish(organizationId, now, err instanceof Error ? err.message : String(err));
    }
  }
  if (Date.now() - lastPrune > 24 * 60 * 60 * 1000) {
    lastPrune = Date.now();
    await pruneScorecardHistory().catch((err: unknown) =>
      console.error("[scorecards] history prune failed:", err),
    );
  }
  return { claimed: claimed.length };
}
