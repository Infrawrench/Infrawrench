/**
 * The org grade: seven pillars read from feeds that already compute them, and
 * one weighted overall. It sits above the per-service scorecard matrix.
 *
 * Nothing here re-derives a finding. Each pillar is a *reading* of one
 * existing radar (posture, backup coverage, the service scorecard results,
 * the expiry feed, the access review, quota utilisation and the ownership
 * records), so a number on the grade can never disagree with the page it
 * links to. That is why the pillars call the feeds rather than the tables.
 *
 * Pillars run concurrently under `allSettled`: one that throws is reported in
 * `failedPillars` and excluded from the overall, exactly as an unassessed one
 * is. The distinction is kept because "you have no quota-reporting provider"
 * is a fact about the org, and "the quota read failed" is a fact about us.
 *
 * The one exception is a gateway-only error: on the edge the posture and
 * backup feeds reach plugin functions the Worker only stubs, and that must
 * replay the request on the gateway rather than render as a failed pillar.
 */
import { and, count, eq, isNull } from "drizzle-orm";
import {
  ORG_SCORECARD_PILLARS,
  ORG_SCORECARD_WEIGHTS,
  combineOrgScorecardPillars,
  findingScore,
  isServiceTier,
  percentClean,
  serviceStandardsReading,
  type OrgScorecardPillar,
  type OrgScorecardPillarId,
  type OrgScorecardResponse,
  type OrgScorecardTrendPoint,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { accounts, resourceOwnership, resources } from "../db/schema";
import { listPosture } from "../posture/feed";
import { listBackupCoverage } from "../backups/feed";
import { listExpiring } from "../expiry/feed";
import { getQuotaFeed } from "../quotas/feed";
import { listAccessReview } from "../access-review/feed";
import { isGatewayOnlyError } from "../runtime/gateway-only";
import { listServiceRecords } from "../service-catalog/store";
import { listScorecardRecords, listScorecardResults, scorecardToWire } from "./store";

export interface ComputeOrgScorecardOptions {
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
  /** Stored history to attach, oldest first. Omitted on the poller path. */
  trend?: OrgScorecardTrendPoint[];
}

/** What each pillar builder returns before weighting. */
type PillarDraft = Omit<OrgScorecardPillar, "id" | "weight">;

function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

function unassessed(headline: string, reason: string): PillarDraft {
  return { score: null, headline, unassessedReason: reason, nextStep: null, facts: [] };
}

// ---------------------------------------------------------------------------
// Pillars
// ---------------------------------------------------------------------------

/**
 * Security posture over the org's own resources. The population is the
 * resource count rather than the finding count, so four criticals across
 * five thousand resources read differently from four across twenty.
 */
async function posturePillar(organizationId: string): Promise<PillarDraft> {
  const [posture, resourceCount] = await Promise.all([
    listPosture(organizationId),
    countResources(organizationId),
  ]);
  if (resourceCount === 0) {
    return unassessed(
      "No synced resources to check",
      "Connect an account and let it sync before posture can be scored.",
    );
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
    nextStep: worst ? `${worst.title}: ${worst.displayName}` : null,
    facts: [
      { label: "Critical", value: String(counts.critical ?? 0), bad: (counts.critical ?? 0) > 0 },
      { label: "High", value: String(counts.high ?? 0), bad: (counts.high ?? 0) > 0 },
      // A low count that is mostly dismissals is a different state from a
      // genuinely clean one.
      { label: "Dismissed", value: String(posture.dismissedCount) },
    ],
  };
}

/**
 * Recoverability, over `statefulCount - unknownCount`: a resource whose
 * provider-native backup setting could not be read is not a gap, and
 * counting it as one would put back the false alarm the coverage computation
 * was careful to keep off the screen.
 */
async function recoverabilityPillar(organizationId: string): Promise<PillarDraft> {
  const coverage = await listBackupCoverage(organizationId);
  const summary = coverage.summary;
  const judged = summary.statefulCount - summary.unknownCount;
  if (judged <= 0) {
    return unassessed(
      "Nothing stateful to protect yet",
      summary.statefulCount === 0
        ? "No synced resource declares that it needs protecting."
        : "Every stateful resource is unassessed: the provider's backup signal could not be read.",
    );
  }
  const worst = coverage.findings[0];
  return {
    score: percentClean(summary.protectedCount, judged),
    headline: `${summary.protectedCount} of ${pluralize(judged, "stateful resource")} protected`,
    unassessedReason: null,
    nextStep: worst ? `${worst.title}: ${worst.displayName}` : null,
    facts: [
      {
        label: "Unprotected",
        value: String(summary.unprotectedCount),
        bad: summary.unprotectedCount > 0,
      },
      {
        label: "Worst RPO",
        value: summary.worstRpoHours === null ? "n/a" : `${Math.round(summary.worstRpoHours)}h`,
      },
      // Reported rather than hidden: "we could not tell" is a third answer.
      { label: "Unassessed", value: String(summary.unknownCount) },
    ],
  };
}

/**
 * Service standards: the per-service scorecard results the matrix below the
 * grade shows, read from the stored results (never re-evaluated here, and
 * never seeding the default scorecard: a read must not create
 * configuration). The mean over scored, tier-applicable pairs; null when
 * nothing is scored, so an org without services is excluded, not zeroed.
 */
async function servicesPillar(organizationId: string, now: number): Promise<PillarDraft> {
  const [cards, serviceRows, results] = await Promise.all([
    listScorecardRecords(organizationId),
    listServiceRecords(organizationId),
    listScorecardResults(organizationId),
  ]);
  const reading = serviceStandardsReading(
    {
      scorecards: cards.map(scorecardToWire),
      services: serviceRows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        tier: isServiceTier(r.tier) ? r.tier : null,
        ownerTeam: r.ownerTeam,
      })),
      results,
    },
    now,
  );
  if (reading.score === null) {
    return unassessed(
      "No service scored yet",
      serviceRows.length === 0
        ? "Define a service and the scorecards will grade it within the hour."
        : reading.pairs === 0
          ? "No enabled scorecard applies to any service."
          : "No scorecard check applies to any service yet, or none has been evaluated.",
    );
  }
  const worst = reading.worst;
  return {
    score: reading.score,
    headline: `Mean of ${pluralize(reading.scored, "service grade")} across your scorecards`,
    unassessedReason: null,
    nextStep:
      worst && worst.score < 100
        ? `${worst.serviceName} on ${worst.scorecardName}: ${Math.round(worst.score)}%`
        : null,
    facts: [
      { label: "Graded", value: String(reading.scored) },
      {
        label: "Below lowest level",
        value: String(reading.belowLowestLevel),
        bad: reading.belowLowestLevel > 0,
      },
      {
        label: "Failing checks",
        value: String(reading.failingChecks),
        bad: reading.failingChecks > 0,
      },
    ],
  };
}

/**
 * Deadlines, from the expiry feed. Anything already expired counts as
 * critical regardless of what it is: a lapsed certificate is an outage
 * somebody has not noticed yet.
 */
async function deadlinesPillar(organizationId: string, now: number): Promise<PillarDraft> {
  const feed = await listExpiring(organizationId, { now });
  if (feed.totalCount === 0) {
    return unassessed(
      "No tracked deadlines",
      "No synced resource declares an expiry date. Certificates, domains, keys and leases all do once their provider syncs them.",
    );
  }
  const worst = feed.items.find((item) => item.severity !== "ok");
  return {
    score: findingScore({
      critical: feed.counts.expired + feed.counts.critical,
      high: feed.counts.warning,
      medium: 0,
      low: 0,
      population: feed.totalCount,
    }),
    headline: pluralize(feed.totalCount, "tracked deadline"),
    unassessedReason: null,
    nextStep: worst
      ? `${worst.displayName}: ${worst.label.toLowerCase()} in ${worst.daysRemaining} days`
      : null,
    facts: [
      { label: "Expired", value: String(feed.counts.expired), bad: feed.counts.expired > 0 },
      { label: "Critical", value: String(feed.counts.critical), bad: feed.counts.critical > 0 },
      { label: "Warning", value: String(feed.counts.warning) },
    ],
  };
}

/** Access hygiene, from the cross-cloud access review. */
async function accessPillar(organizationId: string): Promise<PillarDraft> {
  const review = await listAccessReview(organizationId);
  if (review.principals.length === 0) {
    return unassessed(
      "No cloud principals synced",
      "No connected account has synced IAM users, roles or service accounts yet.",
    );
  }
  const worst = review.findings[0];
  return {
    score: findingScore({
      critical: review.counts.critical ?? 0,
      high: review.counts.high ?? 0,
      medium: review.counts.medium ?? 0,
      low: review.counts.low ?? 0,
      population: review.principals.length,
    }),
    headline: `${pluralize(review.totalCount, "finding")} across ${pluralize(review.principals.length, "principal")}`,
    unassessedReason: null,
    nextStep: worst ? `${worst.title}: ${worst.principal.displayName}` : null,
    facts: [
      {
        label: "Critical",
        value: String(review.counts.critical ?? 0),
        bad: (review.counts.critical ?? 0) > 0,
      },
      { label: "High", value: String(review.counts.high ?? 0), bad: (review.counts.high ?? 0) > 0 },
      // "We found nothing" and "we could not look" must not read alike.
      { label: "No last-use evidence", value: String(review.unknownActivityCount) },
    ],
  };
}

/**
 * Headroom, scored on the *worst* quota rather than the mean, because that
 * is what will stop a deploy. An average across two hundred healthy quotas
 * would hide the one at 99%.
 */
async function headroomPillar(organizationId: string, now: number): Promise<PillarDraft> {
  const feed = await getQuotaFeed(organizationId, new Date(now));
  if (feed.rows.length === 0) {
    return unassessed(
      "No quota readings",
      feed.unsupportedPluginIds.length > 0
        ? `No connected provider reports quotas (${feed.unsupportedPluginIds.join(", ")} do not expose them).`
        : "No account has reported a quota yet.",
    );
  }
  const worst = feed.rows.reduce((a, b) => (b.utilization > a.utilization ? b : a));
  const overThreshold = feed.rows.filter((row) => row.utilization >= feed.threshold);
  return {
    // A quota at 100% is a zero: "you cannot create another".
    score: Math.max(0, Math.min(100, Math.round((1 - worst.utilization) * 100))),
    headline: `Worst quota at ${Math.round(worst.utilization * 100)}%: ${worst.name}`,
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

/**
 * Ownership, the share of resources somebody has put their name against.
 * The lightest pillar on purpose: it measures a habit rather than a risk,
 * but every other pillar depends on it, since a finding nobody owns is a
 * finding nobody fixes.
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
    return unassessed("No synced resources", "Connect an account and let it sync.");
  }
  // Clamped: an ownership row can outlive its resource, and 103% owned would
  // be a stranger thing to show than 100%.
  const owned = Math.min(ownedRows[0]?.value ?? 0, resourceCount);
  return {
    score: percentClean(owned, resourceCount),
    headline: `${owned} of ${pluralize(resourceCount, "resource")} with a recorded owner`,
    unassessedReason: null,
    nextStep:
      owned < resourceCount
        ? `${pluralize(resourceCount - owned, "resource")} with nobody's name on them`
        : null,
    facts: [
      { label: "Owned", value: String(owned) },
      { label: "Unowned", value: String(resourceCount - owned), bad: owned < resourceCount },
    ],
  };
}

/** Live resources in the org, the denominator two pillars share. */
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
  OrgScorecardPillarId,
  (organizationId: string, now: number) => Promise<PillarDraft>
> = {
  posture: (org) => posturePillar(org),
  recoverability: (org) => recoverabilityPillar(org),
  services: (org, now) => servicesPillar(org, now),
  deadlines: (org, now) => deadlinesPillar(org, now),
  access: (org) => accessPillar(org),
  headroom: (org, now) => headroomPillar(org, now),
  ownership: (org) => ownershipPillar(org),
};

/** The org grade: seven pillars, one weighted overall, and any history passed in. */
export async function computeOrgScorecard(
  organizationId: string,
  options: ComputeOrgScorecardOptions = {},
): Promise<OrgScorecardResponse> {
  const now = options.now ?? Date.now();
  const settled = await Promise.allSettled(
    ORG_SCORECARD_PILLARS.map((id) => BUILDERS[id](organizationId, now)),
  );

  // On the edge, let the request replay on the gateway rather than render
  // the plugin-bound pillars as failures.
  for (const result of settled) {
    if (result.status === "rejected" && isGatewayOnlyError(result.reason)) throw result.reason;
  }

  const pillars: OrgScorecardPillar[] = [];
  const failedPillars: OrgScorecardPillarId[] = [];
  settled.forEach((result, index) => {
    const id = ORG_SCORECARD_PILLARS[index]!;
    const weight = ORG_SCORECARD_WEIGHTS[id];
    if (result.status === "rejected") {
      console.error(`[scorecards] org grade pillar ${id} failed:`, result.reason);
      failedPillars.push(id);
      pillars.push({
        id,
        weight,
        score: null,
        headline: "Could not be read",
        // Deliberately not phrased as a fact about the org: this one is ours.
        unassessedReason: "This check failed to run. It is excluded from the grade.",
        nextStep: null,
        facts: [],
      });
      return;
    }
    pillars.push({ id, weight, ...result.value });
  });

  const combined = combineOrgScorecardPillars(pillars);
  return {
    score: combined.score,
    grade: combined.grade,
    pillars,
    failedPillars,
    trend: options.trend ?? [],
    generatedAt: new Date(now).toISOString(),
  };
}
