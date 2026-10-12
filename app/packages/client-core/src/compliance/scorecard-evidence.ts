/**
 * The service scorecard evidence, computed purely from the scorecards
 * overview (every enabled scorecard, every service, the stored result per
 * pair) so it is testable without a database.
 *
 * What it shows an auditor is that operational readiness is evaluated
 * continuously against a written bar: every service a scorecard applies to,
 * its score and level at generation time, and which checks it fails and
 * why. The org scopes each scorecard to the tiers it cares about, so a
 * service below the lowest level of a scorecard that applies to it is a gap;
 * a check that fails while the service still reaches a level is a figure.
 */
import type { ScorecardOverviewResponse, ScorecardCheckStatus } from "../scorecards";
import { scorecardAppliesTo } from "../scorecards";
import type { ServiceTier } from "../services";

const HOUR_MS = 3_600_000;

/**
 * A result older than this reads as stale. Scorecards are evaluated hourly,
 * so two days without a fresh result means the evaluation stopped, and the
 * stored levels no longer describe the services.
 */
export const SCORECARD_EVIDENCE_STALE_HOURS = 48;

/** One failing check on one service, as the pack prints it. */
export interface ScorecardFailingCheck {
  name: string;
  /** `error` counts as failing, the scoring rule. */
  status: Extract<ScorecardCheckStatus, "fail" | "error">;
  detail: string | null;
}

/** One (scorecard, service) pair the scorecard applies to. */
export interface ScorecardEvidenceRow {
  scorecardId: string;
  scorecardName: string;
  serviceId: string;
  serviceName: string;
  tier: ServiceTier | null;
  ownerTeam: string | null;
  /** 0-100; null when no check applied or the pair was never evaluated. */
  score: number | null;
  level: string | null;
  levelName: string | null;
  /** Scored, the scorecard defines levels, and the score reaches none of them. */
  belowLowestLevel: boolean;
  checksPassed: number;
  checksFailed: number;
  checksNotApplicable: number;
  failingChecks: ScorecardFailingCheck[];
  /** Null when no result is stored yet. */
  evaluatedAt: string | null;
  stale: boolean;
}

export interface ScorecardEvidencePerScorecard {
  scorecardId: string;
  name: string;
  /** Services the scorecard applies to. */
  services: number;
  scored: number;
  /** Evaluated, but no check applied. */
  notScored: number;
  /** No stored result yet. */
  notEvaluated: number;
  belowLowestLevel: number;
  /** Lowest level first, the ladder's own order. */
  levels: Array<{ key: string; name: string; services: number }>;
  medianScore: number | null;
}

export interface ScorecardEvidenceSummary {
  /** Enabled scorecards. */
  scorecardCount: number;
  serviceCount: number;
  /** Applicable (scorecard, service) pairs. */
  pairs: number;
  scored: number;
  notScored: number;
  notEvaluated: number;
  belowLowestLevel: number;
  /** Pairs whose result is older than {@link SCORECARD_EVIDENCE_STALE_HOURS}. */
  stale: number;
  /** Failing or erroring check results across every pair. */
  failingChecks: number;
  /** Newest evaluation across every pair; null when none. */
  lastEvaluatedAt: string | null;
  byScorecard: ScorecardEvidencePerScorecard[];
  rows: ScorecardEvidenceRow[];
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(value * 10) / 10;
}

export function summarizeScorecardEvidence(
  overview: Pick<ScorecardOverviewResponse, "scorecards" | "services" | "results">,
  now: number,
): ScorecardEvidenceSummary {
  const results = new Map(overview.results.map((r) => [`${r.scorecardId}:${r.serviceId}`, r]));
  const cards = overview.scorecards.filter((c) => c.enabled);
  const rows: ScorecardEvidenceRow[] = [];
  const byScorecard: ScorecardEvidencePerScorecard[] = [];
  let lastEvaluated = Number.NEGATIVE_INFINITY;

  for (const card of cards) {
    const ladder = [...card.levels].sort((a, b) => a.minScore - b.minScore);
    const levelCounts = new Map(ladder.map((l) => [l.key, 0]));
    const scores: number[] = [];
    const entry: ScorecardEvidencePerScorecard = {
      scorecardId: card.id,
      name: card.name,
      services: 0,
      scored: 0,
      notScored: 0,
      notEvaluated: 0,
      belowLowestLevel: 0,
      levels: [],
      medianScore: null,
    };
    for (const service of overview.services) {
      // A stored result for a service the scorecard no longer applies to (its
      // tier changed) is left out: it is not evidence of the current bar.
      if (!scorecardAppliesTo(card, service.tier)) continue;
      entry.services++;
      const result = results.get(`${card.id}:${service.id}`);
      const failingChecks: ScorecardFailingCheck[] = [];
      let passed = 0;
      let notApplicable = 0;
      for (const check of result?.checks ?? []) {
        if (check.status === "pass") passed++;
        else if (check.status === "not_applicable") notApplicable++;
        else failingChecks.push({ name: check.name, status: check.status, detail: check.detail });
      }
      const evaluatedMs = result ? Date.parse(result.evaluatedAt) : Number.NaN;
      if (!Number.isNaN(evaluatedMs)) lastEvaluated = Math.max(lastEvaluated, evaluatedMs);
      const score = result?.score ?? null;
      const belowLowestLevel = score !== null && ladder.length > 0 && result?.level == null;
      if (!result) entry.notEvaluated++;
      else if (score === null) entry.notScored++;
      else {
        entry.scored++;
        scores.push(score);
      }
      if (belowLowestLevel) entry.belowLowestLevel++;
      if (result?.level != null && levelCounts.has(result.level)) {
        levelCounts.set(result.level, levelCounts.get(result.level)! + 1);
      }
      rows.push({
        scorecardId: card.id,
        scorecardName: card.name,
        serviceId: service.id,
        serviceName: service.name,
        tier: service.tier,
        ownerTeam: service.ownerTeam,
        score,
        level: result?.level ?? null,
        levelName: result?.levelName ?? null,
        belowLowestLevel,
        checksPassed: passed,
        checksFailed: failingChecks.length,
        checksNotApplicable: notApplicable,
        failingChecks,
        evaluatedAt: result?.evaluatedAt ?? null,
        stale:
          !Number.isNaN(evaluatedMs) &&
          now - evaluatedMs > SCORECARD_EVIDENCE_STALE_HOURS * HOUR_MS,
      });
    }
    entry.levels = ladder.map((l) => ({
      key: l.key,
      name: l.name,
      services: levelCounts.get(l.key) ?? 0,
    }));
    entry.medianScore = median(scores);
    byScorecard.push(entry);
  }

  const sum = (pick: (e: ScorecardEvidencePerScorecard) => number) =>
    byScorecard.reduce((n, e) => n + pick(e), 0);
  return {
    scorecardCount: cards.length,
    serviceCount: overview.services.length,
    pairs: rows.length,
    scored: sum((e) => e.scored),
    notScored: sum((e) => e.notScored),
    notEvaluated: sum((e) => e.notEvaluated),
    belowLowestLevel: sum((e) => e.belowLowestLevel),
    stale: rows.filter((r) => r.stale).length,
    failingChecks: rows.reduce((n, r) => n + r.checksFailed, 0),
    lastEvaluatedAt: Number.isFinite(lastEvaluated) ? new Date(lastEvaluated).toISOString() : null,
    byScorecard,
    rows,
  };
}

/**
 * Plain-language gaps: services below the lowest level of a scorecard that
 * applies to them, and results too old to describe the services any more.
 * Individual failing checks are figures and rows, not gaps: a service can
 * miss one check and still meet the bar the org set.
 */
export function scorecardEvidenceGaps(summary: ScorecardEvidenceSummary): string[] {
  const gaps: string[] = [];
  for (const card of summary.byScorecard) {
    if (card.belowLowestLevel > 0) {
      const lowest = card.levels[0]?.name ?? "lowest";
      gaps.push(
        `${card.belowLowestLevel} service(s) are below the ${lowest} level of "${card.name}"`,
      );
    }
  }
  if (summary.stale > 0) {
    gaps.push(
      `${summary.stale} scorecard result(s) are more than ${SCORECARD_EVIDENCE_STALE_HOURS} hours old`,
    );
  }
  return gaps;
}
