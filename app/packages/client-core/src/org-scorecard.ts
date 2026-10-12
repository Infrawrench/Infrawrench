/**
 * The org grade: one number over the radars the product already computes,
 * shown above the service scorecard matrix, plus the arithmetic that keeps
 * it honest.
 *
 * Service scorecards grade each service against the org's own checks. The
 * org grade answers the question above that ("how are we doing overall?")
 * by reading seven existing feeds: security posture, backup coverage, the
 * service scorecards themselves, the expiry feed, the access review, quota
 * utilisation and the ownership records. Nothing is re-derived, so a pillar
 * can never disagree with the page it links to. The pillars are assembled
 * server-side (`server-core/src/scorecards/org-grade.ts`); this module is the
 * wire contract and the pure scoring every surface shares.
 *
 * Two rules do the real work, and both are refusals to invent a number:
 *
 * 1. **An unassessed pillar is excluded, never zeroed.** An org with no
 *    quota-reporting provider has no headroom score, not a headroom score of
 *    nought, the same mistake the backup feed avoids by reporting
 *    `unknownCount` separately from `unprotectedCount`.
 * 2. **Weights renormalize over what was assessed.** With four of seven
 *    pillars measurable, the overall is the weighted mean of those four, so
 *    connecting a new provider (or scoring a first service) cannot make
 *    yesterday's grade look like a regression.
 */
import type { CloudFetch } from "./fetch";
import type { ScorecardOverviewResponse } from "./scorecards";
import { summarizeScorecardEvidence } from "./compliance/scorecard-evidence";

export type OrgScorecardPillarId =
  "posture" | "recoverability" | "services" | "deadlines" | "access" | "headroom" | "ownership";

/** Heaviest first; the order every surface lists the pillars in. */
export const ORG_SCORECARD_PILLARS: readonly OrgScorecardPillarId[] = [
  "posture",
  "recoverability",
  "services",
  "deadlines",
  "access",
  "headroom",
  "ownership",
] as const;

/**
 * Relative weight of each pillar in the overall. They sum to 100, though
 * nothing depends on that: {@link combineOrgScorecardPillars} normalizes over
 * whichever pillars were actually assessed.
 *
 * Deliberately unequal and deliberately not configurable. The ordering is a
 * claim the product is willing to defend: an exposed database is worse than
 * an un-owned one, and losing data is worse than running out of a quota you
 * can ask to have raised.
 *
 * Service standards (15) is the pillar that arrived with service scorecards.
 * Its weight came from posture, recoverability and access (5 each). Posture
 * and recoverability pay because the default service scorecard re-reads both
 * feeds per service (`no_critical_posture`, `backups_verified`), so without
 * the trim the same finding would count twice at full weight. Access pays
 * because posture and access together were 45 of 100 for what is one
 * concern, "who or what can reach this", and the service standards pillar
 * carries the operational half (on-call, SLOs, runbooks, vulnerabilities,
 * change failure rate) nothing else on the card measured. Deadlines,
 * headroom and ownership keep their weights relative to one another.
 */
export const ORG_SCORECARD_WEIGHTS: Record<OrgScorecardPillarId, number> = {
  posture: 25,
  recoverability: 20,
  services: 15,
  deadlines: 15,
  access: 10,
  headroom: 10,
  ownership: 5,
};

/** English labels, for the CLI and logs. The UIs translate their own. */
export const ORG_SCORECARD_PILLAR_LABELS: Record<OrgScorecardPillarId, string> = {
  posture: "Security posture",
  recoverability: "Recoverability",
  services: "Service standards",
  deadlines: "Deadlines",
  access: "Access hygiene",
  headroom: "Headroom",
  ownership: "Ownership",
};

/** How much history the page draws. */
export const ORG_SCORECARD_TREND_DAYS = 90;
/** How long daily readings are kept, and the most the history route serves. */
export const ORG_SCORECARD_RETENTION_DAYS = 400;

export type OrgScorecardGrade = "A" | "B" | "C" | "D" | "F";

export interface OrgScorecardFact {
  label: string;
  value: string;
  /** True when the number is the bad one, so the UI can tint it. */
  bad?: boolean;
}

/**
 * One pillar's reading. `score` is null when the pillar could not be
 * assessed, and `unassessedReason` then says why in a sentence a reader can
 * act on rather than leaving a blank cell.
 */
export interface OrgScorecardPillar {
  id: OrgScorecardPillarId;
  /** 0-100, or null when unassessed. Never a fabricated zero. */
  score: number | null;
  weight: number;
  /** What the score measures over, in one line. */
  headline: string;
  /** Why there is no score; null when there is one. */
  unassessedReason: string | null;
  /** The single most valuable thing to fix; null when clean or unassessed. */
  nextStep: string | null;
  /** Counts worth showing beside the bar. Empty when unassessed. */
  facts: OrgScorecardFact[];
}

export interface OrgScorecardTrendPoint {
  /** `YYYY-MM-DD`, the UTC day the reading was taken. */
  day: string;
  score: number;
  grade: OrgScorecardGrade;
  /** Per-pillar scores that day; a pillar unassessed then is absent, not zero. */
  pillars: Partial<Record<OrgScorecardPillarId, number>>;
}

export interface OrgScorecardResponse {
  /** 0-100 over the assessed pillars, or null when none could be assessed. */
  score: number | null;
  grade: OrgScorecardGrade | null;
  pillars: OrgScorecardPillar[];
  /**
   * Pillars that threw while being computed, as opposed to having no data.
   * Excluded from the overall exactly as unassessed ones are, but named
   * apart: one is a fact about the org, the other a fact about us.
   */
  failedPillars: OrgScorecardPillarId[];
  /** Stored daily readings, oldest first. Empty until the first snapshot. */
  trend: OrgScorecardTrendPoint[];
  generatedAt: string;
}

export interface OrgScorecardHistoryResponse {
  trend: OrgScorecardTrendPoint[];
}

/**
 * Grade boundaries. Generous at the top on purpose (a scorecard nobody can
 * reach an A on is one people stop opening); under 50 is an F, and the
 * pillars say which one dragged it there.
 */
export function orgScorecardGrade(score: number): OrgScorecardGrade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  return "F";
}

export interface CombinedOrgScore {
  score: number | null;
  grade: OrgScorecardGrade | null;
  /** Sum of the weights that contributed; 0 when nothing was assessed. */
  assessedWeight: number;
}

/**
 * Weighted mean over the assessed pillars only. Null rather than 0 when
 * nothing could be assessed: a brand new org has nothing to grade, and an F
 * on its first day is a lie told to somebody who has done nothing wrong.
 */
export function combineOrgScorecardPillars(
  pillars: ReadonlyArray<Pick<OrgScorecardPillar, "score" | "weight">>,
): CombinedOrgScore {
  let weighted = 0;
  let assessedWeight = 0;
  for (const pillar of pillars) {
    if (pillar.score === null) continue;
    weighted += pillar.score * pillar.weight;
    assessedWeight += pillar.weight;
  }
  if (assessedWeight === 0) return { score: null, grade: null, assessedWeight: 0 };
  const score = Math.round(weighted / assessedWeight);
  return { score, grade: orgScorecardGrade(score), assessedWeight };
}

/**
 * A count of clean things over a population, as a whole percentage. Null for
 * an empty population rather than 100: "none of your nought resources are
 * unprotected" is an absence of evidence, not a passing grade.
 */
export function percentClean(clean: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((clean / total) * 100)));
}

/**
 * Severity-weighted findings over the population they were drawn from, as a
 * score. Ten lows are not one critical, and a hundred findings across ten
 * thousand resources reads better than ten across twenty.
 *
 * The scale is steep on purpose: the population is clamped to 10..200, so a
 * five-resource org is not scored out of existence by one finding, and past
 * 200 the denominator stops growing, so a large org cannot hide a pile of
 * criticals inside its size.
 */
export function findingScore(options: {
  critical: number;
  high: number;
  medium: number;
  low: number;
  population: number;
}): number | null {
  if (options.population <= 0) return null;
  const penalty =
    options.critical * 8 + options.high * 4 + options.medium * 1.5 + options.low * 0.5;
  const scale = Math.max(10, Math.min(options.population, 200));
  const scaled = (penalty / scale) * 100;
  return Math.max(0, Math.min(100, Math.round(100 - scaled)));
}

/**
 * The pillar dragging the overall down hardest: the weighted gap from 100,
 * not simply the lowest score. A 40 on a 5-weight pillar matters less than a
 * 70 on a 25-weight one.
 */
export function orgScorecardBiggestDrag<P extends Pick<OrgScorecardPillar, "score" | "weight">>(
  pillars: readonly P[],
): P | null {
  let worst: P | null = null;
  let worstLoss = 0;
  for (const pillar of pillars) {
    if (pillar.score === null) continue;
    const loss = (100 - pillar.score) * pillar.weight;
    if (loss > worstLoss) {
      worstLoss = loss;
      worst = pillar;
    }
  }
  return worst;
}

/**
 * Change against the oldest point in the trend, or null when there is
 * nothing to compare against. The trend is oldest first, so an accidental
 * reversal would report every improvement as a decline.
 */
export function orgScorecardTrendDelta(
  trend: readonly OrgScorecardTrendPoint[],
  current: number | null,
): number | null {
  if (current === null) return null;
  const first = trend[0];
  if (!first) return null;
  return current - first.score;
}

export interface ServiceStandardsReading {
  /** Mean of the scored pairs' scores, rounded; null when nothing is scored. */
  score: number | null;
  /** Applicable (scorecard, service) pairs, enabled scorecards only. */
  pairs: number;
  scored: number;
  belowLowestLevel: number;
  failingChecks: number;
  /** The lowest-scoring pair, for the next step. */
  worst: { serviceName: string; scorecardName: string; score: number } | null;
}

/**
 * The service standards pillar's reading of the scorecard matrix: the mean
 * score over every (scorecard, service) pair the scorecard applies to by
 * tier and has scored. The same pairs, by construction, that the matrix
 * draws and the compliance evidence lists, because all three go through
 * {@link summarizeScorecardEvidence}. A pair with no applicable check, or
 * never evaluated, is left out rather than counted as zero.
 */
export function serviceStandardsReading(
  overview: Pick<ScorecardOverviewResponse, "scorecards" | "services" | "results">,
  now: number,
): ServiceStandardsReading {
  const summary = summarizeScorecardEvidence(overview, now);
  let total = 0;
  let scored = 0;
  let worst: ServiceStandardsReading["worst"] = null;
  for (const row of summary.rows) {
    if (row.score === null) continue;
    total += row.score;
    scored++;
    if (!worst || row.score < worst.score) {
      worst = { serviceName: row.serviceName, scorecardName: row.scorecardName, score: row.score };
    }
  }
  return {
    score: scored === 0 ? null : Math.max(0, Math.min(100, Math.round(total / scored))),
    pairs: summary.pairs,
    scored,
    belowLowestLevel: summary.belowLowestLevel,
    failingChecks: summary.failingChecks,
    worst,
  };
}

// ---------------------------------------------------------------------------
// Bearer fetch helpers
// ---------------------------------------------------------------------------

/** `GET /api/org/:orgId/scorecards/org`: the org grade, its pillars and history. */
export async function fetchOrgScorecard(
  api: CloudFetch,
  orgId: string,
): Promise<OrgScorecardResponse | null> {
  return api.org<OrgScorecardResponse>(orgId, "/scorecards/org");
}

/** `GET /api/org/:orgId/scorecards/org/history?days=`: stored readings alone. */
export async function fetchOrgScorecardHistory(
  api: CloudFetch,
  orgId: string,
  days?: number,
): Promise<OrgScorecardHistoryResponse> {
  const query = days === undefined ? "" : `?days=${encodeURIComponent(String(days))}`;
  const res = await api.org<OrgScorecardHistoryResponse>(orgId, `/scorecards/org/history${query}`);
  return res ?? { trend: [] };
}
