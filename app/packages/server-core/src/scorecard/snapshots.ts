/**
 * Daily scorecard readings — recording one, and reading the history back.
 *
 * The concurrency protocol is the unique index and nothing else. `(org, day)`
 * is unique and the insert is `onConflictDoNothing`, so N poller replicas
 * racing the same day produce one row without a lock, a claim column or a
 * settings table — the `budget_alert_events` once-per-period trick.
 *
 * A day whose score could not be computed at all (no assessed pillars) writes
 * **no row**. A trend line is a claim that something was measured; a null
 * plotted as zero is how a chart lies.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import type { ScorecardResponse, ScorecardTrendPoint } from "@infrawrench/client-core";

import { db } from "../db/client";
import { accounts, organizations } from "../db/schema";
import { scorecardSnapshots } from "../db/scorecard-schema";
import { computeScorecard } from "./compute";

/** How much history the page draws, and how far the prune keeps rows. */
export const SCORECARD_TREND_DAYS = 90;
export const SCORECARD_RETENTION_DAYS = 400;

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` in UTC — the key the unique index is on. */
export function scorecardDay(at: number | Date = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The org's stored readings, oldest first.
 *
 * Oldest-first because that is chart order, and because `trendDelta` compares
 * against the first element — an accidental reversal there would report every
 * improvement as a decline.
 */
export async function listScorecardTrend(
  organizationId: string,
  options: { days?: number; now?: number } = {},
): Promise<ScorecardTrendPoint[]> {
  const days = options.days ?? SCORECARD_TREND_DAYS;
  const since = scorecardDay((options.now ?? Date.now()) - days * MS_PER_DAY);
  const rows = await db
    .select({
      day: scorecardSnapshots.day,
      score: scorecardSnapshots.score,
      grade: scorecardSnapshots.grade,
      pillars: scorecardSnapshots.pillars,
    })
    .from(scorecardSnapshots)
    .where(
      and(
        eq(scorecardSnapshots.organizationId, organizationId),
        gte(scorecardSnapshots.day, since),
      ),
    )
    .orderBy(scorecardSnapshots.day);
  return rows.map((row) => ({
    day: row.day,
    score: row.score,
    grade: row.grade as ScorecardTrendPoint["grade"],
    pillars: row.pillars as ScorecardTrendPoint["pillars"],
  }));
}

/** The org's scorecard with its history attached — what the API returns. */
export async function getScorecard(
  organizationId: string,
  options: { now?: number } = {},
): Promise<ScorecardResponse> {
  const now = options.now ?? Date.now();
  const [scorecard, trend] = await Promise.all([
    computeScorecard(organizationId, { now }),
    listScorecardTrend(organizationId, { now }),
  ]);
  return { ...scorecard, trend };
}

export interface RecordSnapshotResult {
  /** False when today's row already existed, or when there was nothing to record. */
  recorded: boolean;
  score: number | null;
}

/**
 * Compute and store today's reading for one org.
 *
 * Returns rather than throws on an unscoreable org: a poller pass that treated
 * "this org has no accounts yet" as an error would spend its whole log on
 * trials.
 */
export async function recordScorecardSnapshot(
  organizationId: string,
  options: { now?: number } = {},
): Promise<RecordSnapshotResult> {
  const now = options.now ?? Date.now();
  const scorecard = await computeScorecard(organizationId, { now });
  if (scorecard.score === null || scorecard.grade === null) {
    return { recorded: false, score: null };
  }

  const pillars: Record<string, number> = {};
  for (const pillar of scorecard.pillars) {
    // Absent, not zero: a history that cannot tell "we scored badly" from "we
    // could not look" reintroduces in the trend the lie the live computation
    // refuses to tell.
    if (pillar.score !== null) pillars[pillar.id] = pillar.score;
  }

  const inserted = await db
    .insert(scorecardSnapshots)
    .values({
      id: randomUUID(),
      organizationId,
      day: scorecardDay(now),
      score: scorecard.score,
      grade: scorecard.grade,
      pillars,
    })
    .onConflictDoNothing()
    .returning({ id: scorecardSnapshots.id });

  return { recorded: inserted.length > 0, score: scorecard.score };
}

export interface ScorecardSnapshotPassOptions {
  /** Orgs to attempt per tick. Bounded so one tick cannot run for an hour. */
  limit?: number;
  now?: number;
}

/**
 * Record today's snapshot for orgs that do not have one yet.
 *
 * Never throws: the pass runs inside the poller loop and must not be able to
 * fail a tick. One org's failure is logged and the rest continue — the same
 * stance every other radar pass takes.
 */
export async function runScorecardSnapshotPass(
  options: ScorecardSnapshotPassOptions = {},
): Promise<{ attempted: number; recorded: number }> {
  const limit = options.limit ?? 4;
  const now = options.now ?? Date.now();
  const day = scorecardDay(now);

  let due: { id: string }[];
  try {
    // Orgs with no row for today *and* at least one live account.
    //
    // The account condition is load-bearing, not an optimisation. An org with
    // nothing connected scores null, which writes no row — so without it every
    // empty org and every abandoned trial stays permanently "due" and the pass
    // recomputes six feeds for each of them on every tick, forever. `NOT
    // EXISTS` rather than a left join so the planner can stop at the first
    // matching snapshot per org.
    due = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          sql`NOT EXISTS (
            SELECT 1 FROM ${scorecardSnapshots}
            WHERE ${scorecardSnapshots.organizationId} = ${organizations.id}
              AND ${scorecardSnapshots.day} = ${day}
          )`,
          sql`EXISTS (
            SELECT 1 FROM ${accounts}
            WHERE ${accounts.organizationId} = ${organizations.id}
              AND ${accounts.deletedAt} IS NULL
          )`,
        ),
      )
      .limit(limit);
  } catch (e) {
    console.error("[scorecard] failed to list orgs due a snapshot:", e);
    return { attempted: 0, recorded: 0 };
  }

  let recorded = 0;
  for (const org of due) {
    try {
      const result = await recordScorecardSnapshot(org.id, { now });
      if (result.recorded) recorded += 1;
    } catch (e) {
      console.error(`[scorecard] snapshot failed for org ${org.id}:`, e);
    }
  }
  return { attempted: due.length, recorded };
}

/** Drop readings past the retention window. Idempotent; safe to race. */
export async function pruneScorecardSnapshots(now = new Date()): Promise<number> {
  const cutoff = scorecardDay(now.getTime() - SCORECARD_RETENTION_DAYS * MS_PER_DAY);
  const deleted = await db
    .delete(scorecardSnapshots)
    .where(sql`${scorecardSnapshots.day} < ${cutoff}`)
    .returning({ id: scorecardSnapshots.id });
  return deleted.length;
}
