/**
 * Score every service on every enabled scorecard for one org, store the
 * results and the day's history, and announce level drops.
 *
 * One {@link ServiceSignals} per evaluation, so the posture scan, the orphan
 * finder and the backup coverage feed each run once for the org however many
 * services and scorecards there are.
 *
 * **Level drops are claimed, not just compared.** The stored `level` is the
 * claim column: a replica writes the new level with `WHERE level IS NOT
 * DISTINCT FROM <the level it read>`, and only the replica whose update lands
 * announces the drop, so N replicas evaluating the same org send one alert.
 * The first evaluation of a (scorecard, service) pair never announces: there
 * is nothing to have dropped from. Rises are recorded and never announced to
 * people; event subscriptions get `scorecard.level_changed` for a claimed move
 * in either direction.
 *
 * A drop that reached nobody is **not** rolled back, unlike the SLO claim:
 * the stored level is what every page shows, and leaving it a level too high
 * so the next pass can retry the message would make the page lie.
 */
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  computeScorecardScore,
  SCORECARD_LEVEL_CHANGED,
  isScorecardLevelDrop,
  scorecardAppliesTo,
  scorecardCheckName,
  scorecardLevelDirection,
  scorecardLevelFor,
  type Scorecard,
  type ScorecardCheckResult,
  type ScorecardResult,
  type Service,
  type ServiceMember,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { resources, scorecardHistory, scorecardResults, scorecards } from "../db/schema";
import { routeAlert } from "../alerts/route";
import { orgAppUrl } from "../app-url";
import { publishEvent } from "../events/publish";
import { ServiceSignals } from "../service-catalog/signals";
import { loadServicesWithMembers } from "../service-catalog/store";
import { scorecardCheckEvaluator } from "./checks";
import { listScorecardRecords, scorecardToWire } from "./store";

export interface ScorecardEvalOutcome {
  services: number;
  results: number;
  drops: number;
}

/** Evaluate one service against one scorecard. Pure apart from the signals it reads. */
export async function scoreService(
  scorecard: Scorecard,
  service: Service,
  members: ServiceMember[],
  memberFields: Map<string, Record<string, unknown>>,
  signals: ServiceSignals,
): Promise<Omit<ScorecardResult, "evaluatedAt">> {
  const checks: ScorecardCheckResult[] = await Promise.all(
    scorecard.checks.map(async (check) => {
      const evaluate = scorecardCheckEvaluator(check.type);
      const base = {
        checkId: check.id,
        type: check.type,
        name: scorecardCheckName(check),
        weight: check.weight,
      };
      if (!evaluate) {
        return { ...base, status: "error" as const, detail: "This check type is not supported." };
      }
      try {
        const outcome = await evaluate({ service, members, memberFields, signals }, check.params);
        return { ...base, ...outcome };
      } catch (err) {
        console.error(`[scorecards] check ${check.type} failed for ${service.id}:`, err);
        return { ...base, status: "error" as const, detail: "The check could not be evaluated." };
      }
    }),
  );
  const score = computeScorecardScore(checks);
  const level = scorecardLevelFor(score, scorecard.levels);
  return {
    scorecardId: scorecard.id,
    scorecardName: scorecard.name,
    serviceId: service.id,
    score,
    level: level?.key ?? null,
    levelName: level?.name ?? null,
    checks,
  };
}

async function loadMemberFields(
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 500) {
    const rows = await db
      .select({ id: resources.id, fields: resources.fieldsJson })
      .from(resources)
      .where(
        and(
          eq(resources.organizationId, organizationId),
          inArray(resources.id, unique.slice(i, i + 500)),
        ),
      );
    for (const r of rows) out.set(r.id, r.fields);
  }
  return out;
}

async function announceDrop(
  organizationId: string,
  scorecard: Scorecard,
  service: Service,
  previous: string | null,
  result: Omit<ScorecardResult, "evaluatedAt">,
): Promise<void> {
  const from = scorecard.levels.find((l) => l.key === previous)?.name ?? previous ?? "none";
  const to = result.levelName ?? "no level";
  const failing = result.checks.filter((c) => c.status === "fail" || c.status === "error");
  const lines = failing.slice(0, 5).map((c) => `• ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  try {
    await routeAlert({
      organizationId,
      trigger: "scorecardAlerts",
      severity: "warning",
      title: `${service.name} dropped from ${from} to ${to} on "${scorecard.name}"`,
      body:
        `Score ${result.score === null ? "not scored" : `${Math.round(result.score)}%`}.` +
        (lines.length > 0 ? `\nFailing checks:\n${lines.join("\n")}` : ""),
      pushBody: `${from} to ${to}: ${failing.length} failing ${failing.length === 1 ? "check" : "checks"}`,
      context: `Scorecard · ${scorecard.name}`,
      url: orgAppUrl(organizationId, `services/${service.id}`),
      pushData: {
        type: "scorecard_level_drop",
        orgId: organizationId,
        serviceId: service.id,
        scorecardId: scorecard.id,
      },
      facts: { key: service.name },
    });
  } catch (err) {
    console.error(`[scorecards] level-drop alert for ${service.id} failed:`, err);
  }
}

/**
 * `scorecard.level_changed`. No idempotency key, the SLO stance: the
 * conditional update in {@link storeResult} already made this replica the only
 * one that saw the move.
 */
async function publishLevelChange(
  organizationId: string,
  scorecard: Scorecard,
  service: Service,
  previous: string | null,
  direction: "up" | "down",
  result: Omit<ScorecardResult, "evaluatedAt">,
): Promise<void> {
  const previousLevelName = scorecard.levels.find((l) => l.key === previous)?.name ?? null;
  const from = previousLevelName ?? previous ?? "no level";
  const to = result.levelName ?? result.level ?? "no level";
  await publishEvent(
    SCORECARD_LEVEL_CHANGED,
    organizationId,
    {
      scorecardId: scorecard.id,
      scorecardName: scorecard.name,
      serviceId: service.id,
      serviceSlug: service.slug,
      serviceName: service.name,
      direction,
      previousLevel: previous,
      previousLevelName,
      level: result.level,
      levelName: result.levelName,
      score: result.score,
      failingChecks: result.checks
        .filter((c) => c.status === "fail" || c.status === "error")
        .map((c) => c.name),
    },
    {
      title: `${service.name} ${direction === "up" ? "rose" : "dropped"} from ${from} to ${to} on "${scorecard.name}"`,
      severity: direction === "down" ? "warning" : "info",
      url: orgAppUrl(organizationId, `services/${service.id}`),
    },
  );
}

/**
 * Write one result. Returns true when this call recorded a level drop it
 * should announce.
 */
async function storeResult(
  organizationId: string,
  scorecard: Scorecard,
  result: Omit<ScorecardResult, "evaluatedAt">,
  now: Date,
): Promise<{ dropped: boolean; moved: "up" | "down" | null; previous: string | null }> {
  const [existing] = await db
    .select({ level: scorecardResults.level })
    .from(scorecardResults)
    .where(
      and(
        eq(scorecardResults.scorecardId, scorecard.id),
        eq(scorecardResults.serviceId, result.serviceId),
      ),
    )
    .limit(1);
  const values = {
    score: result.score,
    level: result.level,
    checkResults: result.checks,
    evaluatedAt: now,
  };
  if (!existing) {
    await db
      .insert(scorecardResults)
      .values({ scorecardId: scorecard.id, serviceId: result.serviceId, organizationId, ...values })
      .onConflictDoUpdate({
        target: [scorecardResults.scorecardId, scorecardResults.serviceId],
        set: values,
      });
    return { dropped: false, moved: null, previous: null };
  }
  const updated = await db
    .update(scorecardResults)
    .set(values)
    .where(
      and(
        eq(scorecardResults.scorecardId, scorecard.id),
        eq(scorecardResults.serviceId, result.serviceId),
        sql`${scorecardResults.level} IS NOT DISTINCT FROM ${existing.level}`,
      ),
    )
    .returning({ serviceId: scorecardResults.serviceId });
  const claimed = updated.length > 0;
  return {
    dropped: claimed && isScorecardLevelDrop(existing.level, result.level, scorecard.levels),
    moved: claimed ? scorecardLevelDirection(existing.level, result.level, scorecard.levels) : null,
    previous: existing.level,
  };
}

export async function evaluateOrgScorecards(
  organizationId: string,
  opts: { now?: Date; scorecardIds?: readonly string[]; announce?: boolean } = {},
): Promise<ScorecardEvalOutcome> {
  const now = opts.now ?? new Date();
  const announce = opts.announce ?? true;
  const cards = (await listScorecardRecords(organizationId))
    .filter((r) => r.enabled)
    .filter((r) => !opts.scorecardIds || opts.scorecardIds.includes(r.id))
    .map(scorecardToWire);
  const outcome: ScorecardEvalOutcome = { services: 0, results: 0, drops: 0 };
  if (cards.length === 0) return outcome;

  const entries = await loadServicesWithMembers(organizationId);
  outcome.services = entries.length;
  const signals = new ServiceSignals(organizationId, now.getTime());
  const memberFields = await loadMemberFields(
    organizationId,
    entries.flatMap((e) => e.membership.members.map((m) => m.resourceId)),
  );
  const day = now.toISOString().slice(0, 10);

  for (const card of cards) {
    const applicable = entries.filter((e) => scorecardAppliesTo(card, e.service.tier));
    for (const entry of applicable) {
      const members = entry.membership.members.filter((m) => !m.missing);
      const result = await scoreService(card, entry.service, members, memberFields, signals);
      const { dropped, moved, previous } = await storeResult(organizationId, card, result, now);
      await db
        .insert(scorecardHistory)
        .values({
          scorecardId: card.id,
          serviceId: entry.service.id,
          organizationId,
          day,
          score: result.score,
          level: result.level,
        })
        .onConflictDoUpdate({
          target: [scorecardHistory.scorecardId, scorecardHistory.serviceId, scorecardHistory.day],
          set: { score: result.score, level: result.level },
        });
      outcome.results += 1;
      // Systems hear about every move, both directions, and whether or not
      // the caller announces: a manual evaluation that moved the bar still
      // moved the level, and the next pass will not see it again.
      if (moved)
        await publishLevelChange(organizationId, card, entry.service, previous, moved, result);
      if (dropped) {
        outcome.drops += 1;
        if (announce && card.alertOnLevelDrop) {
          await announceDrop(organizationId, card, entry.service, previous, result);
        }
      }
    }
    // A service that left the scorecard's tiers (or was re-tiered) has no
    // current result on it; history stays as the record of what it was.
    const keep = applicable.map((e) => e.service.id);
    await db
      .delete(scorecardResults)
      .where(
        and(
          eq(scorecardResults.scorecardId, card.id),
          keep.length > 0 ? notInArray(scorecardResults.serviceId, keep) : undefined,
        ),
      );
    await db.update(scorecards).set({ lastEvaluatedAt: now }).where(eq(scorecards.id, card.id));
  }
  return outcome;
}
