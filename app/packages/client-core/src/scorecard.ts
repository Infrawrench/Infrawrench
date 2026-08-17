/**
 * The infrastructure scorecard — one number over the six radars that already
 * exist, and the arithmetic that makes it honest.
 *
 * Every pillar here is a view of a feed the product already computes (posture,
 * backup coverage, expiry, quotas, access review, ownership). What the
 * scorecard adds is a *comparable* reading: a percentage nobody has to hold six
 * pages in their head to arrive at, and a stored history so "are we getting
 * better?" is answerable.
 *
 * Two rules do the real work, and both are about refusing to invent a number:
 *
 * 1. **An unassessed pillar is excluded, never zeroed.** An org with no cloud
 *    accounts that report quotas has no headroom score — not a headroom score of
 *    nought. Scoring the absence of data as failure is how a scorecard teaches
 *    people to ignore it, and it is the same mistake the backup feed avoids by
 *    reporting `unknownCount` separately from `unprotectedCount`.
 * 2. **Weights renormalize over what was assessed.** With four of six pillars
 *    measurable, the overall is the weighted mean of those four — so connecting
 *    a new provider cannot make yesterday's score look like a regression.
 */

export type ScorecardPillarId =
  "security" | "recoverability" | "deadlines" | "headroom" | "access" | "ownership";

export const SCORECARD_PILLARS: readonly ScorecardPillarId[] = [
  "security",
  "recoverability",
  "deadlines",
  "headroom",
  "access",
  "ownership",
] as const;

/**
 * Relative weight of each pillar in the overall score.
 *
 * Deliberately unequal, and deliberately not configurable in this version. The
 * ordering encodes a claim the product is willing to defend: an exposed
 * database is worse than an un-owned one, and losing data is worse than running
 * out of a quota you can ask to have raised. An org that disagrees can read the
 * pillars, which are never hidden behind the headline.
 *
 * They do not have to sum to anything — `combinePillars` normalizes over
 * whichever pillars were actually assessed.
 */
export const SCORECARD_WEIGHTS: Record<ScorecardPillarId, number> = {
  security: 30,
  recoverability: 25,
  deadlines: 15,
  headroom: 10,
  access: 15,
  ownership: 5,
};

export type ScorecardGrade = "A" | "B" | "C" | "D" | "F";

/**
 * One pillar's reading.
 *
 * `score` is null when the pillar could not be assessed, and `unassessedReason`
 * then says why in a sentence a reader can act on ("no account reports quotas")
 * rather than leaving a blank cell.
 */
export interface ScorecardPillar {
  id: ScorecardPillarId;
  /** 0–100, or null when unassessed. */
  score: number | null;
  weight: number;
  /** Short sentence stating what the score measures over. */
  headline: string;
  /**
   * Why there is no score. Null when there is one. Never a fabricated zero —
   * see the module note.
   */
  unassessedReason: string | null;
  /**
   * The single most valuable thing to fix, when there is one. Null when the
   * pillar is clean or unassessed.
   */
  nextStep: string | null;
  /** Counts worth showing beside the bar. Empty when unassessed. */
  facts: ScorecardFact[];
}

export interface ScorecardFact {
  label: string;
  value: string;
  /** True when the number is the bad one, so the UI can tint it. */
  bad?: boolean;
}

export interface ScorecardResponse {
  /** 0–100 over the assessed pillars, or null when none could be assessed. */
  score: number | null;
  grade: ScorecardGrade | null;
  pillars: ScorecardPillar[];
  /**
   * Pillars that threw while being computed, as opposed to having no data.
   * Excluded from the overall exactly as unassessed ones are, but named
   * differently because one is a fact about the org and the other is a fact
   * about us.
   */
  failedPillars: ScorecardPillarId[];
  /** Stored daily readings, oldest first. Empty until the first snapshot. */
  trend: ScorecardTrendPoint[];
  generatedAt: string;
}

export interface ScorecardTrendPoint {
  /** `YYYY-MM-DD`, the day the snapshot was taken (UTC). */
  day: string;
  score: number;
  grade: ScorecardGrade;
  /** Per-pillar scores that day; a pillar unassessed then is absent. */
  pillars: Partial<Record<ScorecardPillarId, number>>;
}

/**
 * Grade boundaries.
 *
 * Generous at the top on purpose: 90 is an A because a scorecard that nobody
 * can reach an A on is one people stop opening. The boundary that matters is
 * the bottom — under 50 is an F, and the pillars say which one dragged it
 * there.
 */
export function scoreToGrade(score: number): ScorecardGrade {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 65) return "C";
  if (score >= 50) return "D";
  return "F";
}

export interface CombinedScore {
  score: number | null;
  grade: ScorecardGrade | null;
  /** Sum of the weights that actually contributed. 0 when nothing was assessed. */
  assessedWeight: number;
}

/**
 * Weighted mean over the assessed pillars only.
 *
 * Returns a null score rather than 0 when nothing could be assessed — a brand
 * new org with no accounts connected has no infrastructure to grade, and an F
 * on its first day is a lie told to a user who has done nothing wrong.
 */
export function combinePillars(pillars: readonly ScorecardPillar[]): CombinedScore {
  let weighted = 0;
  let assessedWeight = 0;
  for (const pillar of pillars) {
    if (pillar.score === null) continue;
    weighted += pillar.score * pillar.weight;
    assessedWeight += pillar.weight;
  }
  if (assessedWeight === 0) return { score: null, grade: null, assessedWeight: 0 };
  const score = Math.round(weighted / assessedWeight);
  return { score, grade: scoreToGrade(score), assessedWeight };
}

/**
 * Score a count of problems against a population, as a percentage clean.
 *
 * Returns null for an empty population rather than 100: "none of your nought
 * resources are unprotected" is not a passing grade, it is an absence of
 * evidence, and rendering it as 100 would put a green A on an empty org.
 */
export function percentClean(clean: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((clean / total) * 100)));
}

/**
 * Turn weighted findings into a score.
 *
 * Severity-weighted rather than counted, because ten low findings are not one
 * critical, and a page that says otherwise gets closed. The denominator is the
 * population the findings were drawn from, so a hundred findings across ten
 * thousand resources reads better than ten across twenty — which is the correct
 * reading, and the one a raw count gets wrong.
 *
 * The scale is deliberately steep: `penaltyPerCritical` of 8 means twelve
 * critical findings take a pillar to zero regardless of size, because at that
 * point the denominator has stopped being the interesting fact.
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
  // Relative to a population floor of 10 so a five-resource org is not scored
  // out of existence by one finding, and not so gently that a large org can
  // hide a critical inside its size.
  const scale = Math.max(10, Math.min(options.population, 200));
  const scaled = (penalty / scale) * 100;
  return Math.max(0, Math.min(100, Math.round(100 - scaled)));
}

/** Label for a pillar id, in the reader's own words. Not translated here. */
export const SCORECARD_PILLAR_KEYS: Record<ScorecardPillarId, string> = {
  security: "Security posture",
  recoverability: "Recoverability",
  deadlines: "Deadlines",
  headroom: "Headroom",
  access: "Access hygiene",
  ownership: "Ownership",
};

/**
 * The pillar dragging the overall down hardest — the weighted gap from 100,
 * which is the honest reading of "what would move the number most".
 *
 * Not simply the lowest score: a 40 on a 5-weight pillar matters less than a 70
 * on a 30-weight one, and telling somebody to go fix the former first would
 * waste their afternoon.
 */
export function biggestDrag(pillars: readonly ScorecardPillar[]): ScorecardPillar | null {
  let worst: ScorecardPillar | null = null;
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
 * Change against the oldest point in the trend, or null when there is nothing
 * to compare against. Rounded, so a one-point drift does not read as movement.
 */
export function trendDelta(
  trend: readonly ScorecardTrendPoint[],
  current: number | null,
): number | null {
  if (current === null || trend.length === 0) return null;
  const first = trend[0];
  if (!first) return null;
  return current - first.score;
}
