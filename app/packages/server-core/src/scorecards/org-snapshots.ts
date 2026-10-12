/**
 * The org grade's daily readings: recording one, and reading the history
 * back.
 *
 * The concurrency protocol is the primary key and nothing else.
 * `(organization_id, day)` is unique and the insert is `onConflictDoNothing`,
 * so N poller replicas racing the same day produce one row without a lock or
 * a claim column.
 *
 * A day whose grade could not be computed at all (no assessed pillars)
 * writes **no row**. A trend line is a claim that something was measured; a
 * null plotted as zero is how a chart lies.
 */
import { and, asc, eq, gte, sql } from "drizzle-orm";
import {
  ORG_SCORECARD_RETENTION_DAYS,
  ORG_SCORECARD_TREND_DAYS,
  type OrgScorecardResponse,
  type OrgScorecardTrendPoint,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { accounts, orgScorecardSnapshots, organizations } from "../db/schema";
import { computeOrgScorecard } from "./org-grade";

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` in UTC, the key the primary key is on. */
export function orgScorecardDay(at: number | Date = Date.now()): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * The org's stored readings, oldest first: chart order, and the order
 * `orgScorecardTrendDelta` compares against.
 */
export async function listOrgScorecardTrend(
  organizationId: string,
  options: { days?: number; now?: number } = {},
): Promise<OrgScorecardTrendPoint[]> {
  const days = options.days ?? ORG_SCORECARD_TREND_DAYS;
  const since = orgScorecardDay((options.now ?? Date.now()) - days * MS_PER_DAY);
  const rows = await db
    .select({
      day: orgScorecardSnapshots.day,
      score: orgScorecardSnapshots.score,
      grade: orgScorecardSnapshots.grade,
      pillars: orgScorecardSnapshots.pillars,
    })
    .from(orgScorecardSnapshots)
    .where(
      and(
        eq(orgScorecardSnapshots.organizationId, organizationId),
        gte(orgScorecardSnapshots.day, since),
      ),
    )
    .orderBy(asc(orgScorecardSnapshots.day));
  return rows.map((row) => ({
    day: row.day,
    score: row.score,
    grade: row.grade as OrgScorecardTrendPoint["grade"],
    pillars: row.pillars as OrgScorecardTrendPoint["pillars"],
  }));
}

/** The org grade with its history attached: what `GET /scorecards/org` returns. */
export async function getOrgScorecard(
  organizationId: string,
  options: { now?: number } = {},
): Promise<OrgScorecardResponse> {
  const now = options.now ?? Date.now();
  const [grade, trend] = await Promise.all([
    computeOrgScorecard(organizationId, { now }),
    listOrgScorecardTrend(organizationId, { now }),
  ]);
  return { ...grade, trend };
}

export interface RecordOrgScorecardResult {
  /** False when today's row already existed, or when there was nothing to record. */
  recorded: boolean;
  score: number | null;
}

/**
 * Compute and store today's reading for one org. Returns rather than throws
 * on an ungradeable org: "this org has nothing connected yet" is not an
 * error a poller pass should log.
 */
export async function recordOrgScorecardSnapshot(
  organizationId: string,
  options: { now?: number } = {},
): Promise<RecordOrgScorecardResult> {
  const now = options.now ?? Date.now();
  const grade = await computeOrgScorecard(organizationId, { now });
  if (grade.score === null || grade.grade === null) return { recorded: false, score: null };

  const pillars: Record<string, number> = {};
  for (const pillar of grade.pillars) {
    // Absent, not zero: see the table note.
    if (pillar.score !== null) pillars[pillar.id] = pillar.score;
  }

  const inserted = await db
    .insert(orgScorecardSnapshots)
    .values({
      organizationId,
      day: orgScorecardDay(now),
      score: grade.score,
      grade: grade.grade,
      pillars,
    })
    .onConflictDoNothing()
    .returning({ day: orgScorecardSnapshots.day });

  return { recorded: inserted.length > 0, score: grade.score };
}

/**
 * Orgs with no reading for `day` *and* at least one live account.
 *
 * The account condition is load-bearing, not an optimisation. An org with
 * nothing connected grades null, which writes no row, so without it every
 * empty org and abandoned trial would stay permanently due and the sweep
 * would recompute seven feeds for each of them on every run, forever.
 */
export async function listOrgsDueScorecardSnapshot(day: string, limit: number) {
  return db
    .select({ id: organizations.id })
    .from(organizations)
    .where(
      and(
        sql`NOT EXISTS (
          SELECT 1 FROM ${orgScorecardSnapshots}
          WHERE ${orgScorecardSnapshots.organizationId} = ${organizations.id}
            AND ${orgScorecardSnapshots.day} = ${day}
        )`,
        sql`EXISTS (
          SELECT 1 FROM ${accounts}
          WHERE ${accounts.organizationId} = ${organizations.id}
            AND ${accounts.deletedAt} IS NULL
        )`,
      ),
    )
    .limit(limit);
}

/**
 * Record today's reading for a bounded batch of orgs that do not have one.
 * Never throws: one org's failure is logged and the rest continue.
 */
export async function runOrgScorecardSnapshotPass(
  options: { limit?: number; now?: number } = {},
): Promise<{ attempted: number; recorded: number }> {
  const limit = options.limit ?? 4;
  const now = options.now ?? Date.now();
  let due: { id: string }[];
  try {
    due = await listOrgsDueScorecardSnapshot(orgScorecardDay(now), limit);
  } catch (err) {
    console.error("[scorecards] failed to list orgs due an org grade snapshot:", err);
    return { attempted: 0, recorded: 0 };
  }
  let recorded = 0;
  for (const org of due) {
    try {
      const result = await recordOrgScorecardSnapshot(org.id, { now });
      if (result.recorded) recorded += 1;
    } catch (err) {
      console.error(`[scorecards] org grade snapshot failed for org ${org.id}:`, err);
    }
  }
  return { attempted: due.length, recorded };
}

/** Drop readings past the retention window. Idempotent; safe to race. */
export async function pruneOrgScorecardSnapshots(now = Date.now()): Promise<number> {
  const cutoff = orgScorecardDay(now - ORG_SCORECARD_RETENTION_DAYS * MS_PER_DAY);
  const deleted = await db
    .delete(orgScorecardSnapshots)
    .where(sql`${orgScorecardSnapshots.day} < ${cutoff}`)
    .returning({ day: orgScorecardSnapshots.day });
  return deleted.length;
}
