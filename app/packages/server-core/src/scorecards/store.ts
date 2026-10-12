/**
 * Scorecards: CRUD, the once-per-org default seed, and result reads.
 *
 * Validation is `validateScorecardInput` from client-core, shared with the
 * editor and mirrored by the Terraform provider's validators.
 *
 * **Seeding happens once.** `org_scorecard_settings.default_seeded_at` records
 * it, so an org that deletes the default scorecard does not get it back on
 * the next read. Seeding runs at org creation and, for orgs created before
 * scorecards existed, on the first read or service write.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  SCORECARD_LIMITS,
  defaultScorecardInput,
  isServiceTier,
  normalizeScorecardInput,
  validateScorecardInput,
  type Scorecard,
  type ScorecardHistoryPoint,
  type ScorecardInput,
  type ScorecardResult,
  type ServiceTier,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/errors";
import { orgScorecardSettings, scorecardHistory, scorecardResults, scorecards } from "../db/schema";

export type ScorecardRecord = typeof scorecards.$inferSelect;

export class ScorecardInputError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ScorecardInputError";
  }
}

export function scorecardToWire(row: ScorecardRecord): Scorecard {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    checks: row.checks,
    levels: row.levels,
    applicableTiers: row.applicableTiers.filter(isServiceTier) as ServiceTier[],
    alertOnLevelDrop: row.alertOnLevelDrop,
    enabled: row.enabled,
    isDefault: row.isDefault,
    lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Insert the default scorecard unless this org has been seeded before. Safe
 * to call on every read: the claim is one conditional insert/update on the
 * settings row, and only the caller that flips `default_seeded_at` seeds.
 */
export async function ensureDefaultScorecard(organizationId: string): Promise<void> {
  await db.insert(orgScorecardSettings).values({ organizationId }).onConflictDoNothing();
  const claimed = await db
    .update(orgScorecardSettings)
    .set({ defaultSeededAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(orgScorecardSettings.organizationId, organizationId),
        isNull(orgScorecardSettings.defaultSeededAt),
      ),
    )
    .returning({ organizationId: orgScorecardSettings.organizationId });
  if (claimed.length === 0) return;
  const input = defaultScorecardInput();
  await db
    .insert(scorecards)
    .values({
      id: randomUUID(),
      organizationId,
      name: input.name,
      description: input.description,
      checks: input.checks,
      levels: input.levels,
      applicableTiers: input.applicableTiers,
      alertOnLevelDrop: input.alertOnLevelDrop,
      enabled: input.enabled,
      isDefault: true,
    })
    .onConflictDoNothing();
}

export async function listScorecardRecords(organizationId: string): Promise<ScorecardRecord[]> {
  return db
    .select()
    .from(scorecards)
    .where(eq(scorecards.organizationId, organizationId))
    .orderBy(asc(scorecards.name));
}

export async function getScorecardRecord(
  organizationId: string,
  scorecardId: string,
): Promise<ScorecardRecord | null> {
  const [row] = await db
    .select()
    .from(scorecards)
    .where(and(eq(scorecards.organizationId, organizationId), eq(scorecards.id, scorecardId)))
    .limit(1);
  return row ?? null;
}

/** Fill a partial body from defaults (create) or the stored row (update). */
export function scorecardInputFrom(
  body: Partial<ScorecardInput>,
  base?: Scorecard,
): ScorecardInput {
  const d = base ?? { ...defaultScorecardInput(), name: "", description: null };
  const pick = <K extends keyof ScorecardInput>(key: K): ScorecardInput[K] =>
    body[key] !== undefined ? (body[key] as ScorecardInput[K]) : d[key];
  return {
    name: pick("name"),
    description: pick("description"),
    checks: pick("checks"),
    levels: pick("levels"),
    applicableTiers: pick("applicableTiers"),
    alertOnLevelDrop: pick("alertOnLevelDrop"),
    enabled: pick("enabled"),
  };
}

function validated(input: ScorecardInput): ScorecardInput {
  const problem = validateScorecardInput(input);
  if (problem) throw new ScorecardInputError(problem);
  return normalizeScorecardInput(input);
}

function conflict(err: unknown): never {
  if (isUniqueViolation(err)) {
    throw new ScorecardInputError("A scorecard with that name already exists", 409);
  }
  throw err;
}

/** Bring the org's evaluation due date forward so a change is scored within a tick. */
export async function markScorecardsDue(organizationId: string): Promise<void> {
  await db
    .insert(orgScorecardSettings)
    .values({ organizationId, nextEvalAt: null })
    .onConflictDoUpdate({
      target: orgScorecardSettings.organizationId,
      set: { nextEvalAt: null, updatedAt: new Date() },
    });
}

export async function createScorecardRecord(
  organizationId: string,
  body: Partial<ScorecardInput>,
  userId?: string | null,
): Promise<ScorecardRecord> {
  const input = validated(scorecardInputFrom(body));
  try {
    const [row] = await db
      .insert(scorecards)
      .values({
        id: randomUUID(),
        organizationId,
        ...input,
        createdByUserId: userId ?? null,
      })
      .returning();
    await markScorecardsDue(organizationId);
    return row!;
  } catch (err) {
    conflict(err);
  }
}

export async function updateScorecardRecord(
  organizationId: string,
  scorecardId: string,
  body: Partial<ScorecardInput>,
): Promise<ScorecardRecord> {
  const current = await getScorecardRecord(organizationId, scorecardId);
  if (!current) throw new ScorecardInputError("Scorecard not found", 404);
  const input = validated(scorecardInputFrom(body, scorecardToWire(current)));
  try {
    const [row] = await db
      .update(scorecards)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(scorecards.organizationId, organizationId), eq(scorecards.id, scorecardId)))
      .returning();
    // Results computed against the old checks or levels describe a different
    // scorecard; the next pass rewrites them. Levels are compared by key, so a
    // renamed ladder must not read as a drop.
    await markScorecardsDue(organizationId);
    return row!;
  } catch (err) {
    conflict(err);
  }
}

export async function deleteScorecardRecord(
  organizationId: string,
  scorecardId: string,
): Promise<ScorecardRecord> {
  const current = await getScorecardRecord(organizationId, scorecardId);
  if (!current) throw new ScorecardInputError("Scorecard not found", 404);
  await db
    .delete(scorecards)
    .where(and(eq(scorecards.organizationId, organizationId), eq(scorecards.id, scorecardId)));
  return current;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export async function listScorecardResults(
  organizationId: string,
  opts: { serviceId?: string } = {},
): Promise<ScorecardResult[]> {
  const rows = await db
    .select({
      scorecardId: scorecardResults.scorecardId,
      scorecardName: scorecards.name,
      levels: scorecards.levels,
      serviceId: scorecardResults.serviceId,
      score: scorecardResults.score,
      level: scorecardResults.level,
      checks: scorecardResults.checkResults,
      evaluatedAt: scorecardResults.evaluatedAt,
    })
    .from(scorecardResults)
    .innerJoin(scorecards, eq(scorecards.id, scorecardResults.scorecardId))
    .where(
      and(
        eq(scorecardResults.organizationId, organizationId),
        eq(scorecards.enabled, true),
        opts.serviceId ? eq(scorecardResults.serviceId, opts.serviceId) : undefined,
      ),
    );
  return rows.map((r) => ({
    scorecardId: r.scorecardId,
    scorecardName: r.scorecardName,
    serviceId: r.serviceId,
    score: r.score,
    level: r.level,
    levelName: r.levels.find((l) => l.key === r.level)?.name ?? null,
    checks: r.checks,
    evaluatedAt: r.evaluatedAt.toISOString(),
  }));
}

export async function listScorecardHistory(
  organizationId: string,
  serviceId: string,
  now = Date.now(),
): Promise<Record<string, ScorecardHistoryPoint[]>> {
  const since = new Date(now - SCORECARD_LIMITS.historyDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const rows = await db
    .select()
    .from(scorecardHistory)
    .where(
      and(
        eq(scorecardHistory.organizationId, organizationId),
        eq(scorecardHistory.serviceId, serviceId),
        gte(scorecardHistory.day, since),
      ),
    )
    .orderBy(asc(scorecardHistory.day));
  const out: Record<string, ScorecardHistoryPoint[]> = {};
  for (const row of rows) {
    (out[row.scorecardId] ??= []).push({ day: row.day, score: row.score, level: row.level });
  }
  return out;
}

/** Retention for the daily history: older rows than the history window are dropped. */
export async function pruneScorecardHistory(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - (SCORECARD_LIMITS.historyDays + 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const deleted = await db
    .delete(scorecardHistory)
    .where(sql`${scorecardHistory.day} < ${cutoff}`)
    .returning({ day: scorecardHistory.day });
  return deleted.length;
}
