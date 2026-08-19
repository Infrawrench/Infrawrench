/**
 * Assemble the six scorecard pillars from the feeds that already compute them.
 *
 * Nothing here re-derives a finding. Each pillar is a *reading* of one existing
 * radar — posture, backup coverage, the expiry feed, quota utilisation, the
 * access review, and the ownership records — so a number on the scorecard can
 * never disagree with the page it links to. That is the whole reason the
 * pillars call the feeds rather than the tables.
 *
 * Pillars are computed concurrently and collected with `allSettled`: one that
 * throws is reported in `failedPillars` and excluded from the overall, exactly
 * as an unassessed one is. The distinction is kept because the two mean
 * different things — "you have no quota-reporting provider" is a fact about the
 * org, "the quota read failed" is a fact about us — and a summary page that
 * blurs them teaches people to distrust it.
 */
import { and, count, eq, isNull } from "drizzle-orm";
import {
  SCORECARD_PILLARS,
  SCORECARD_WEIGHTS,
  combinePillars,
  findingScore,
  percentClean,
  type ScorecardPillar,
  type ScorecardPillarId,
  type ScorecardResponse,
  type ScorecardTrendPoint,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { accounts, resourceOwnership, resources } from "../db/schema";
import { listPosture } from "../posture/feed";
import { listBackupCoverage } from "../backups/feed";
import { listExpiring } from "../expiry/feed";
import { getQuotaFeed } from "../quotas/feed";
import { listAccessReview } from "../access-review/feed";

export interface ComputeScorecardOptions {
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
  /** Stored history to attach, oldest first. Omitted on the poller path. */
  trend?: ScorecardTrendPoint[];
}

/** Shorthand for the shape each pillar builder returns before weighting. */
type PillarDraft = Omit<ScorecardPillar, "id" | "weight">;

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------

/**
 * Security posture, over the org's own resources.
 *
 * The population is the resource count rather than the finding count, so an org
 * with four criticals across five thousand resources reads differently from one
 * with four across twenty — which is the correct reading, and the one a bare
 * count gets wrong.
 */
async function securityPillar(organizationId: string): Promise<PillarDraft> {
  const [posture, resourceCount] = await Promise.all([
    listPosture(organizationId),
    countResources(organizationId),
  ]);
  if (resourceCount === 0) {
    return {
      score: null,
      headline: "No synced resources to check",
      unassessedReason: "Connect an account and let it sync before posture can be scored.",
      nextStep: null,
      facts: [],
    };
  }
  const counts = posture.counts;
  const score = findingScore({
    critical: counts.critical ?? 0,
    high: counts.high ?? 0,
    medium: counts.medium ?? 0,
    low: counts.low ?? 0,
    population: resourceCount,
  });
  const worst = posture.findings[0];
  return {
    score,
    headline: `${pluralize(posture.totalCount, "open finding")} across ${pluralize(resourceCount, "resource")}`,
    unassessedReason: null,
    nextStep: worst ? `${worst.title} — ${worst.displayName}` : null,
    facts: [
      { label: "Critical", value: String(counts.critical ?? 0), bad: (counts.critical ?? 0) > 0 },
      { label: "High", value: String(counts.high ?? 0), bad: (counts.high ?? 0) > 0 },
      // Dismissals are shown because a low finding count that is mostly
      // dismissals is a different state from a genuinely clean one.
      { label: "Dismissed", value: String(posture.dismissedCount) },
    ],
  };
}

/**
 * Recoverability, from backup coverage.
 *
 * Measured over `statefulCount − unknownCount`: a resource whose provider-native
 * backup setting could not be read is not a gap, and counting it as one would
 * put the false alarm back on the screen that the coverage computation was
 * careful to keep off it.
 */
async function recoverabilityPillar(organizationId: string): Promise<PillarDraft> {
  const coverage = await listBackupCoverage(organizationId);
  const summary = coverage.summary;
  const judged = summary.statefulCount - summary.unknownCount;
  if (judged <= 0) {
    return {
      score: null,
      headline: "Nothing stateful to protect yet",
      unassessedReason:
        summary.statefulCount === 0
          ? "No synced resource declares that it needs protecting."
          : "Every stateful resource is unassessed — the provider's backup signal could not be read.",
      nextStep: null,
      facts: [],
    };
  }
  const score = percentClean(summary.protectedCount, judged);
  const worst = coverage.findings[0];
  return {
    score,
    headline: `${summary.protectedCount} of ${pluralize(judged, "stateful resource")} protected`,
    unassessedReason: null,
    nextStep: worst ? `${worst.title} — ${worst.displayName}` : null,
    facts: [
      {
        label: "Unprotected",
        value: String(summary.unprotectedCount),
        bad: summary.unprotectedCount > 0,
      },
      {
        label: "Worst RPO",
        value: summary.worstRpoHours === null ? "—" : `${Math.round(summary.worstRpoHours)}h`,
      },
      // Reported rather than hidden: "we could not tell" is a third answer.
      { label: "Unassessed", value: String(summary.unknownCount) },
    ],
  };
}

/**
 * Deadlines, from the expiry feed.
 *
 * Anything already expired is treated as critical regardless of what it is: a
 * lapsed certificate is not a warning, it is an outage somebody has not noticed
 * yet.
 */
async function deadlinesPillar(organizationId: string, now: number): Promise<PillarDraft> {
  const feed = await listExpiring(organizationId, { now });
  if (feed.totalCount === 0) {
    return {
      score: null,
      headline: "No tracked deadlines",
      unassessedReason:
        "No synced resource declares an expiry date. Certificates, domains, keys and leases all do once their provider syncs them.",
      nextStep: null,
      facts: [],
    };
  }
  const score = findingScore({
    critical: feed.counts.expired + feed.counts.critical,
    high: feed.counts.warning,
    medium: 0,
    low: 0,
    population: feed.totalCount,
  });
  const worst = feed.items.find((item) => item.severity !== "ok");
  return {
    score,
    headline: `${pluralize(feed.totalCount, "tracked deadline")}`,
    unassessedReason: null,
    nextStep: worst
      ? `${worst.displayName} — ${worst.label.toLowerCase()} in ${worst.daysRemaining} days`
      : null,
    facts: [
      { label: "Expired", value: String(feed.counts.expired), bad: feed.counts.expired > 0 },
      { label: "Critical", value: String(feed.counts.critical), bad: feed.counts.critical > 0 },
      { label: "Warning", value: String(feed.counts.warning) },
    ],
  };
}

/**
 * Headroom, from quota utilisation.
 *
 * Scored on the *worst* quota rather than the mean, because that is what will
 * actually stop a deploy. An average across two hundred healthy quotas would
 * hide the one at 99% behind them, which is precisely the failure the quota
 * radar exists to prevent.
 */
async function headroomPillar(organizationId: string, now: number): Promise<PillarDraft> {
  const feed = await getQuotaFeed(organizationId, new Date(now));
  if (feed.rows.length === 0) {
    return {
      score: null,
      headline: "No quota readings",
      unassessedReason:
        feed.unsupportedPluginIds.length > 0
          ? `No connected provider reports quotas (${feed.unsupportedPluginIds.join(", ")} do not expose them).`
          : "No account has reported a quota yet.",
      nextStep: null,
      facts: [],
    };
  }
  const worst = feed.rows.reduce((a, b) => (b.utilization > a.utilization ? b : a));
  const overThreshold = feed.rows.filter((row) => row.utilization >= feed.threshold);
  // The score is the headroom on the worst quota, floored at zero. A quota at
  // 100% is a zero, which is the honest reading of "you cannot create another".
  const score = Math.max(0, Math.min(100, Math.round((1 - worst.utilization) * 100)));
  return {
    score,
    headline: `Worst quota at ${Math.round(worst.utilization * 100)}% — ${worst.name}`,
    unassessedReason: null,
    nextStep:
      overThreshold.length > 0
        ? `${worst.service} ${worst.name} on ${worst.accountName}: ${worst.used} of ${worst.limit}`
        : null,
    facts: [
      { label: "Quotas tracked", value: String(feed.rows.length) },
      {
        label: `Over ${Math.round(feed.threshold * 100)}%`,
        value: String(overThreshold.length),
        bad: overThreshold.length > 0,
      },
    ],
  };
}

/** Access hygiene, from the cross-cloud access review. */
async function accessPillar(organizationId: string): Promise<PillarDraft> {
  const review = await listAccessReview(organizationId);
  if (review.principals.length === 0) {
    return {
      score: null,
      headline: "No cloud principals synced",
      unassessedReason: "No connected account has synced IAM users, roles or service accounts yet.",
      nextStep: null,
      facts: [],
    };
  }
  const score = findingScore({
    critical: review.counts.critical ?? 0,
    high: review.counts.high ?? 0,
    medium: review.counts.medium ?? 0,
    low: review.counts.low ?? 0,
    population: review.principals.length,
  });
  const worst = review.findings[0];
  return {
    score,
    headline: `${pluralize(review.totalCount, "finding")} across ${pluralize(review.principals.length, "principal")}`,
    unassessedReason: null,
    nextStep: worst ? `${worst.title} — ${worst.principal.displayName}` : null,
    facts: [
      {
        label: "Critical",
        value: String(review.counts.critical ?? 0),
        bad: (review.counts.critical ?? 0) > 0,
      },
      { label: "High", value: String(review.counts.high ?? 0), bad: (review.counts.high ?? 0) > 0 },
      // Named on every surface: "we found nothing" and "we could not look" must
      // not read alike.
      { label: "No last-use evidence", value: String(review.unknownActivityCount) },
    ],
  };
}

/**
 * Ownership — the share of resources somebody has put their name against.
 *
 * The lightest-weighted pillar on purpose. It measures a habit rather than a
 * risk, but it is the habit every other pillar depends on: a critical finding
 * on a resource nobody owns is a finding nobody fixes.
 */
async function ownershipPillar(organizationId: string): Promise<PillarDraft> {
  const [resourceCount, ownedRows] = await Promise.all([
    countResources(organizationId),
    db
      .select({ value: count() })
      .from(resourceOwnership)
      .where(eq(resourceOwnership.organizationId, organizationId)),
  ]);
  if (resourceCount === 0) {
    return {
      score: null,
      headline: "No synced resources",
      unassessedReason: "Connect an account and let it sync.",
      nextStep: null,
      facts: [],
    };
  }
  // Clamped: an ownership row can outlive the resource it names, and 103% owned
  // would be a stranger thing to show than 100%.
  const owned = Math.min(ownedRows[0]?.value ?? 0, resourceCount);
  return {
    score: percentClean(owned, resourceCount),
    headline: `${owned} of ${pluralize(resourceCount, "resource")} has a recorded owner`,
    unassessedReason: null,
    nextStep:
      owned < resourceCount
        ? `${resourceCount - owned} resources have nobody's name on them`
        : null,
    facts: [
      { label: "Owned", value: String(owned) },
      { label: "Unowned", value: String(resourceCount - owned), bad: owned < resourceCount },
    ],
  };
}

/** Live resources in the org — the denominator two pillars share. */
async function countResources(organizationId: string): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(
      and(
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
        isNull(accounts.deletedAt),
      ),
    );
  return rows[0]?.value ?? 0;
}

const BUILDERS: Record<
  ScorecardPillarId,
  (organizationId: string, now: number) => Promise<PillarDraft>
> = {
  security: (org) => securityPillar(org),
  recoverability: (org) => recoverabilityPillar(org),
  deadlines: (org, now) => deadlinesPillar(org, now),
  headroom: (org, now) => headroomPillar(org, now),
  access: (org) => accessPillar(org),
  ownership: (org) => ownershipPillar(org),
};

/**
 * The org's scorecard: six pillars, one weighted overall, and whatever history
 * the caller passes in.
 */
export async function computeScorecard(
  organizationId: string,
  options: ComputeScorecardOptions = {},
): Promise<ScorecardResponse> {
  const now = options.now ?? Date.now();
  const settled = await Promise.allSettled(
    SCORECARD_PILLARS.map((id) => BUILDERS[id](organizationId, now)),
  );

  const pillars: ScorecardPillar[] = [];
  const failedPillars: ScorecardPillarId[] = [];
  settled.forEach((result, index) => {
    const id = SCORECARD_PILLARS[index]!;
    const weight = SCORECARD_WEIGHTS[id];
    if (result.status === "rejected") {
      console.error(`[scorecard] pillar ${id} failed:`, result.reason);
      failedPillars.push(id);
      pillars.push({
        id,
        weight,
        score: null,
        headline: "Could not be read",
        // Deliberately not phrased as a fact about the org: this one is ours.
        unassessedReason: "This check failed to run. It is excluded from the score.",
        nextStep: null,
        facts: [],
      });
      return;
    }
    pillars.push({ id, weight, ...result.value });
  });

  const combined = combinePillars(pillars);
  return {
    score: combined.score,
    grade: combined.grade,
    pillars,
    failedPillars,
    trend: options.trend ?? [],
    generatedAt: new Date(now).toISOString(),
  };
}
