/**
 * Evidence-source evaluators: the server half of the evidence-source
 * registry (`client-core/src/compliance/sources.ts`).
 *
 * One evaluator per source id. Each reads what the product already stores
 * (it never calls a provider), and returns the source's result for the
 * status screen plus the rows the evidence pack carries for it as CSV and
 * JSON. Snapshot sources read the feed as it stands now; period sources
 * filter their log to `[start, end)`.
 *
 * Every evaluator is honest about absence in the way its source module
 * already is: nothing to look at is `no-data`, never `present`, and the
 * caller (`status.ts`) turns a throw into `unavailable` so one broken feed
 * costs the pack one source rather than the whole document.
 *
 * Extension point: {@link registerEvidenceEvaluator}. A later feature that
 * adds an evidence source registers its client-core definition with
 * `registerEvidenceSource`, registers an evaluator here under the same id,
 * and adds the id to the controls it speaks to in the framework files.
 */
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  accessReviewToCsv,
  getEvidenceSource,
  isServiceTier,
  LEAK_DISMISS_REASON_LABELS,
  LEAKED_SECRET_STATUSES,
  leakedCredentialEvidenceGaps,
  scorecardEvidenceGaps,
  summarizeLeakedCredentialEvidence,
  summarizeScorecardEvidence,
  summarizeVulnerabilityEvidence,
  toComplianceCsv,
  vulnerabilityEvidenceGaps,
  type LeakedSecret,
  type CompliancePeriod,
  type EvidenceMetric,
  type EvidenceSourceId,
  type EvidenceSourceResult,
  type EvidenceStatus,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import {
  auditLogs,
  changeFreezes,
  incidentNotes,
  incidents,
  jitAccessPolicies,
  jitAccessRequests,
  resourceChanges,
  restoreDrills,
  sshSessionRecordings,
  users,
  vulnerabilityResolutions,
} from "../db/schema";
import { listAccessReview } from "../access-review/feed";
import { listPosture } from "../posture/feed";
import { listBackupCoverage } from "../backups/feed";
import { listDrillCoverage } from "../backups/drills";
import { listVulnerabilities } from "../vulnerabilities/feed";
import { listJitGrantIssues } from "../jit-access/service";
import { getSessionRecordingSettings } from "../ssh-recording/settings";
import { listLeakedSecrets } from "../leaked-secrets/store";
import { listScorecardRecords, listScorecardResults, scorecardToWire } from "../scorecards/store";
import { listServiceRecords } from "../service-catalog/store";

export interface EvidenceContext {
  organizationId: string;
  period: CompliancePeriod;
  /** Inclusive start of the period, UTC midnight. */
  start: Date;
  /** Exclusive end of the period: UTC midnight after `period.to`. */
  end: Date;
  now: Date;
}

/** What one evaluator returns: the result plus its pack files. */
export interface EvidenceCollection {
  result: EvidenceSourceResult;
  /** The source's rows as CSV, or null when it has none worth a file. */
  csv: string | null;
  /** The source's full evidence as a JSON-serialisable value. */
  json: unknown;
}

export type EvidenceEvaluator = (ctx: EvidenceContext) => Promise<EvidenceCollection>;

/** Most rows any single period source writes into a pack. */
export const MAX_EVIDENCE_ROWS = 10_000;

function build(
  sourceId: EvidenceSourceId,
  status: EvidenceStatus,
  summary: string,
  metrics: EvidenceMetric[],
  gaps: string[],
  itemCount: number,
  csv: string | null,
  json: unknown,
): EvidenceCollection {
  const def = getEvidenceSource(sourceId);
  return {
    result: {
      sourceId,
      label: def?.label ?? sourceId,
      kind: def?.kind ?? "snapshot",
      status,
      summary,
      metrics,
      gaps: status === "gap" ? gaps : [],
      itemCount,
      error: null,
    },
    csv,
    json,
  };
}

function m(key: string, label: string, value: number | string | null): EvidenceMetric {
  return { key, label, value };
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function inPeriod(col: PgColumn, ctx: EvidenceContext) {
  return and(gte(col, ctx.start), lt(col, ctx.end));
}

const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/* ------------------------------------------------------------------ *
 * Snapshot sources
 * ------------------------------------------------------------------ */

const accessReview: EvidenceEvaluator = async (ctx) => {
  const review = await listAccessReview(ctx.organizationId, { now: ctx.now.getTime() });
  const gaps: string[] = [];
  const severe = review.counts.critical + review.counts.high;
  if (severe > 0) gaps.push(`${severe} critical or high access finding(s) are open`);
  const grantIssues = review.jitGrantIssues?.length ?? 0;
  if (grantIssues > 0) gaps.push(`${grantIssues} just-in-time grant(s) did not end cleanly`);
  const status: EvidenceStatus =
    review.principals.length === 0 ? "no-data" : gaps.length > 0 ? "gap" : "present";
  return build(
    "access-review",
    status,
    review.principals.length === 0
      ? "No principals are synced from any connected account."
      : `${review.principals.length} principal(s) reviewed; ${review.totalCount} open finding(s), ${review.dismissedCount} accepted.`,
    [
      m("principals", "Principals", review.principals.length),
      m("open", "Open findings", review.totalCount),
      m("critical", "Critical", review.counts.critical),
      m("high", "High", review.counts.high),
      m("accepted", "Accepted risks", review.dismissedCount),
      m("unknownActivity", "Principals with no usage evidence", review.unknownActivityCount),
      m("staleDays", "Staleness window (days)", review.staleDays),
    ],
    gaps,
    review.findings.length + review.dismissed.length,
    accessReviewToCsv(review),
    review,
  );
};

const posture: EvidenceEvaluator = async (ctx) => {
  const feed = await listPosture(ctx.organizationId, { now: ctx.now.getTime() });
  const severe = feed.counts.critical + feed.counts.high;
  const gaps = severe > 0 ? [`${severe} critical or high posture finding(s) are open`] : [];
  const rows = [
    ...feed.findings.map((f) => ({ ...f, decision: "open", note: null as string | null })),
    ...feed.dismissed.map((f) => ({ ...f, decision: "accepted", note: f.reason ?? null })),
  ];
  return build(
    "posture",
    gaps.length > 0 ? "gap" : "present",
    `${feed.totalCount} open posture finding(s), ${feed.dismissedCount} accepted as known risks.`,
    [
      m("open", "Open findings", feed.totalCount),
      m("critical", "Critical", feed.counts.critical),
      m("high", "High", feed.counts.high),
      m("medium", "Medium", feed.counts.medium),
      m("low", "Low", feed.counts.low),
      m("accepted", "Accepted risks", feed.dismissedCount),
    ],
    gaps,
    rows.length,
    toComplianceCsv(
      [
        "Decision",
        "Severity",
        "Category",
        "Rule",
        "Resource",
        "Type",
        "Account",
        "Plugin",
        "Resource id",
        "Accepted reason",
      ],
      rows.map((r) => [
        r.decision,
        r.severity,
        r.category,
        r.title,
        r.displayName,
        r.resourceTypeName,
        r.accountName,
        r.pluginName,
        r.resourceId,
        r.decision === "accepted" ? r.note : null,
      ]),
    ),
    feed,
  );
};

const vulnerabilities: EvidenceEvaluator = async (ctx) => {
  const [feed, resolutions] = await Promise.all([
    listVulnerabilities(ctx.organizationId, { now: ctx.now.getTime() }),
    db
      .select()
      .from(vulnerabilityResolutions)
      .where(
        and(
          eq(vulnerabilityResolutions.organizationId, ctx.organizationId),
          inPeriod(vulnerabilityResolutions.resolvedAt, ctx),
        ),
      )
      .orderBy(desc(vulnerabilityResolutions.resolvedAt))
      .limit(MAX_EVIDENCE_ROWS),
  ]);
  const records = resolutions.map((r) => ({
    advisoryId: r.advisoryId,
    severity: r.severity,
    accountId: r.accountId,
    artifactKind: r.artifactKind,
    artifactName: r.artifactName,
    firstSeenAt: r.firstSeenAt.toISOString(),
    resolvedAt: r.resolvedAt.toISOString(),
  }));
  const summary = summarizeVulnerabilityEvidence(feed, records, ctx.now.getTime());
  const gaps = vulnerabilityEvidenceGaps(summary);
  const metrics: EvidenceMetric[] = [
    m("scanners", "Connected scanners", summary.scannerCount),
    m("open", "Open findings", summary.totalOpen),
    m("openRunning", "Open on running artifacts", summary.totalOpenRunning),
    m(
      "openNotRunning",
      "Open on artifacts not running",
      summary.totalOpen - summary.totalOpenRunning,
    ),
    m(
      "runningResourcesAtRisk",
      "Running resources with critical or high",
      summary.runningResourcesAtRisk,
    ),
    m("kevRunning", "Running and known exploited", summary.kevRunning),
    m("medianOpenAge", "Median age of open findings (days)", summary.medianOpenAgeDays),
  ];
  for (const row of summary.bySeverity) {
    if (row.severity === "unknown") continue;
    metrics.push(
      m(
        `${row.severity}Open`,
        `${row.severity} open (running)`,
        `${row.open} (${row.openRunning})`,
      ),
    );
    metrics.push(
      m(`${row.severity}Overdue`, `${row.severity} past ${row.targetDays}-day target`, row.overdue),
    );
    metrics.push(m(`${row.severity}Fixed`, `${row.severity} fixed in period`, row.fixed));
    metrics.push(
      m(`${row.severity}MedianFix`, `${row.severity} median days to fix`, row.medianDaysToFix),
    );
  }

  const now = ctx.now.getTime();
  const openRows = feed.findings.map((f) => {
    const seen = Date.parse(f.firstSeenAt ?? f.collectedAt);
    return [
      "open",
      f.advisoryId,
      f.severity,
      f.kev ? "yes" : "no",
      f.running.length > 0 ? "yes" : "no",
      f.running.length,
      f.artifact.kind,
      f.artifact.name,
      f.packageName,
      f.installedVersion,
      f.fixedVersion,
      f.accountName,
      f.scanner,
      f.firstSeenAt ?? f.collectedAt,
      Number.isNaN(seen) ? null : Math.floor((now - seen) / 86_400_000),
      null,
    ] as const;
  });
  const fixedRows = records.map(
    (r) =>
      [
        "fixed",
        r.advisoryId,
        r.severity,
        null,
        null,
        null,
        r.artifactKind,
        r.artifactName,
        null,
        null,
        null,
        r.accountId,
        null,
        r.firstSeenAt,
        Math.floor((Date.parse(r.resolvedAt) - Date.parse(r.firstSeenAt)) / 86_400_000),
        r.resolvedAt,
      ] as const,
  );

  return build(
    "vulnerabilities",
    summary.scannerCount === 0 ? "no-data" : gaps.length > 0 ? "gap" : "present",
    summary.scannerCount === 0
      ? "No vulnerability scanner is connected."
      : `${summary.totalOpen} open finding(s), ${summary.totalOpenRunning} on running artifacts; ${records.length} fixed during the period.`,
    metrics,
    gaps,
    openRows.length + fixedRows.length,
    toComplianceCsv(
      [
        "State",
        "Advisory",
        "Severity",
        "Known exploited",
        "Running",
        "Running resources",
        "Artifact kind",
        "Artifact",
        "Package",
        "Installed",
        "Fixed in",
        "Account",
        "Scanner",
        "First seen",
        "Age or days to fix",
        "Fixed at",
      ],
      [...openRows, ...fixedRows],
    ),
    { summary, findings: feed.findings, dismissedCount: feed.dismissedCount, fixed: records },
  );
};

const scorecardsSource: EvidenceEvaluator = async (ctx) => {
  // The overview the Scorecards view renders, read without seeding the
  // default scorecard: an evidence read must not create configuration.
  const [cards, serviceRows, results] = await Promise.all([
    listScorecardRecords(ctx.organizationId),
    listServiceRecords(ctx.organizationId),
    listScorecardResults(ctx.organizationId),
  ]);
  const summary = summarizeScorecardEvidence(
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
    ctx.now.getTime(),
  );
  const gaps = scorecardEvidenceGaps(summary);
  const metrics: EvidenceMetric[] = [
    m("scorecards", "Enabled scorecards", summary.scorecardCount),
    m("services", "Services", summary.serviceCount),
    m("pairs", "Services graded (per scorecard)", summary.pairs),
    m("belowLowestLevel", "Below the lowest level", summary.belowLowestLevel),
    m("notScored", "Not scored (no check applies)", summary.notScored),
    m("notEvaluated", "Not evaluated yet", summary.notEvaluated),
    m("failingChecks", "Failing checks", summary.failingChecks),
    m("stale", "Results older than 48 hours", summary.stale),
    m("lastEvaluated", "Last evaluated", summary.lastEvaluatedAt),
  ];
  for (const card of summary.byScorecard) {
    metrics.push(
      m(
        `scorecard:${card.scorecardId}`,
        `${card.name}: ${card.levels.map((l) => `${l.name} ${l.services}`).join(", ") || "no levels"}`,
        card.medianScore === null ? null : `median ${card.medianScore}`,
      ),
    );
  }
  const noData = summary.scorecardCount === 0 || summary.pairs === 0;
  return build(
    "scorecards",
    noData ? "no-data" : gaps.length > 0 ? "gap" : "present",
    summary.scorecardCount === 0
      ? "No scorecard is enabled."
      : summary.pairs === 0
        ? "No service falls under an enabled scorecard."
        : `${summary.pairs} service grade(s) across ${summary.scorecardCount} scorecard(s); ${summary.belowLowestLevel} below the lowest level, ${summary.failingChecks} failing check(s).`,
    metrics,
    gaps,
    summary.rows.length,
    toComplianceCsv(
      [
        "Scorecard",
        "Service",
        "Tier",
        "Owner team",
        "Score",
        "Level",
        "Below lowest level",
        "Checks passed",
        "Checks failing",
        "Checks not applicable",
        "Failing checks",
        "Evaluated at",
        "Stale",
        "Service id",
      ],
      summary.rows.map((r) => [
        r.scorecardName,
        r.serviceName,
        r.tier,
        r.ownerTeam,
        r.score,
        r.levelName ?? r.level,
        r.belowLowestLevel ? "yes" : "no",
        r.checksPassed,
        r.checksFailed,
        r.checksNotApplicable,
        r.failingChecks
          .map(
            (c) =>
              `${c.name}${c.status === "error" ? " (could not evaluate)" : ""}${c.detail ? `: ${c.detail}` : ""}`,
          )
          .join("; "),
        r.evaluatedAt,
        r.stale ? "yes" : "no",
        r.serviceId,
      ]),
    ),
    summary,
  );
};

const backupCoverage: EvidenceEvaluator = async (ctx) => {
  const coverage = await listBackupCoverage(ctx.organizationId, {
    now: ctx.now.getTime(),
    skipCosts: true,
  });
  const s = coverage.summary;
  const severe = coverage.counts.critical + coverage.counts.high;
  const gaps =
    severe > 0
      ? [
          `${severe} critical or high backup finding(s) (unprotected data, recovery point breaches, short retention)`,
        ]
      : [];
  return build(
    "backup-coverage",
    s.statefulCount === 0 ? "no-data" : gaps.length > 0 ? "gap" : "present",
    s.statefulCount === 0
      ? "No stateful resources that declare backup coverage are synced."
      : `${s.protectedCount} of ${s.statefulCount} stateful resource(s) protected; ${s.unprotectedCount} unprotected, ${s.unknownCount} could not be assessed.`,
    [
      m("stateful", "Stateful resources", s.statefulCount),
      m("protected", "Protected", s.protectedCount),
      m("unprotected", "Unprotected", s.unprotectedCount),
      m("unknown", "Could not assess", s.unknownCount),
      m("backups", "Backups in inventory", s.backupCount),
      m("findings", "Open findings", coverage.totalCount),
    ],
    gaps,
    coverage.resources.length,
    toComplianceCsv(
      ["Resource", "Type", "Account", "State", "Resource id"],
      coverage.resources.map((r) => [
        r.displayName,
        r.resourceTypeName,
        r.accountName,
        r.state,
        r.resourceId,
      ]),
    ),
    coverage,
  );
};

/* ------------------------------------------------------------------ *
 * Period sources
 * ------------------------------------------------------------------ */

const restoreDrillsSource: EvidenceEvaluator = async (ctx) => {
  const [standing, inPeriodDrills] = await Promise.all([
    listDrillCoverage(ctx.organizationId, { now: ctx.now.getTime() }),
    db
      .select()
      .from(restoreDrills)
      .where(
        and(
          eq(restoreDrills.organizationId, ctx.organizationId),
          inPeriod(restoreDrills.performedAt, ctx),
        ),
      )
      .orderBy(desc(restoreDrills.performedAt))
      .limit(MAX_EVIDENCE_ROWS),
  ]);
  const s = standing.summary;
  const gaps: string[] = [];
  if (s.failedCount > 0) gaps.push(`${s.failedCount} resource(s) whose most recent drill failed`);
  if (s.neverCount > 0)
    gaps.push(`${s.neverCount} protected resource(s) have never been restore-tested`);
  if (s.staleCount > 0)
    gaps.push(`${s.staleCount} resource(s) last verified more than ${standing.validDays} days ago`);
  const names = new Map(standing.rows.map((r) => [r.resourceId, r.resourceName]));
  return build(
    "restore-drills",
    s.eligibleCount === 0 && inPeriodDrills.length === 0
      ? "no-data"
      : gaps.length > 0
        ? "gap"
        : "present",
    s.eligibleCount === 0 && inPeriodDrills.length === 0
      ? "No protected resources and no restore drills recorded."
      : `${inPeriodDrills.length} drill(s) performed during the period; ${s.verifiedCount} of ${s.eligibleCount} protected resource(s) currently verified.`,
    [
      m("drills", "Drills in period", inPeriodDrills.length),
      m("eligible", "Protected resources", s.eligibleCount),
      m("verified", "Verified", s.verifiedCount),
      m("stale", "Verification stale", s.staleCount),
      m("failed", "Last drill failed", s.failedCount),
      m("never", "Never tested", s.neverCount),
      m("medianRto", "Median measured recovery time (min)", s.medianRtoMinutes),
      m("worstRto", "Slowest measured recovery time (min)", s.worstRtoMinutes),
    ],
    gaps,
    inPeriodDrills.length,
    toComplianceCsv(
      [
        "Performed at",
        "Resource",
        "Resource id",
        "Outcome",
        "Recovery time (min)",
        "Restored from",
        "Notes",
      ],
      inPeriodDrills.map((d) => [
        d.performedAt.toISOString(),
        names.get(d.resourceId) ?? null,
        d.resourceId,
        d.outcome,
        d.rtoMinutes,
        d.restoredFrom,
        d.notes,
      ]),
    ),
    { standing, drills: inPeriodDrills },
  );
};

const jitAccess: EvidenceEvaluator = async (ctx) => {
  const [requests, policies, issues] = await Promise.all([
    db
      .select()
      .from(jitAccessRequests)
      .where(
        and(
          eq(jitAccessRequests.organizationId, ctx.organizationId),
          inPeriod(jitAccessRequests.createdAt, ctx),
        ),
      )
      .orderBy(desc(jitAccessRequests.createdAt))
      .limit(MAX_EVIDENCE_ROWS),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(jitAccessPolicies)
      .where(
        and(
          eq(jitAccessPolicies.organizationId, ctx.organizationId),
          eq(jitAccessPolicies.enabled, true),
        ),
      ),
    listJitGrantIssues(ctx.organizationId),
  ]);
  const policyCount = policies[0]?.count ?? 0;
  const count = (pred: (r: (typeof requests)[number]) => boolean) => requests.filter(pred).length;
  const granted = count((r) => r.grantedAt !== null && !r.preexisting);
  const denied = count((r) => r.status === "denied");
  const selfApproved = count((r) => r.selfApproved);
  const gaps =
    issues.length > 0 ? [`${issues.length} grant(s) were not removed cleanly at expiry`] : [];
  return build(
    "jit-access",
    policyCount === 0 && requests.length === 0 ? "no-data" : gaps.length > 0 ? "gap" : "present",
    policyCount === 0 && requests.length === 0
      ? "No just-in-time access policies are configured."
      : `${requests.length} request(s) during the period: ${granted} granted, ${denied} denied.`,
    [
      m("policies", "Enabled policies", policyCount),
      m("requests", "Requests in period", requests.length),
      m("granted", "Granted", granted),
      m("denied", "Denied", denied),
      m("selfApproved", "Self-approved during an incident", selfApproved),
      m("grantIssues", "Grants not removed cleanly", issues.length),
    ],
    gaps,
    requests.length,
    toComplianceCsv(
      [
        "Requested at",
        "Requester",
        "Account",
        "Scope",
        "Role",
        "Principal",
        "Reason",
        "Ticket",
        "Minutes",
        "Status",
        "Decided by",
        "Decided at",
        "Self-approved",
        "Granted at",
        "Expires at",
        "Ended at",
        "End reason",
      ],
      requests.map((r) => [
        r.createdAt.toISOString(),
        r.userName ?? r.userEmail ?? r.userId,
        r.accountName ?? r.accountId,
        r.scopeName,
        r.roleName,
        r.principalName,
        r.reason,
        r.ticket,
        r.durationMinutes + r.extendedMinutes,
        r.status,
        r.decidedByName,
        iso(r.decidedAt),
        r.selfApproved ? "yes" : "no",
        iso(r.grantedAt),
        iso(r.grantExpiresAt),
        iso(r.endedAt),
        r.endReason,
      ]),
    ),
    { requests, grantIssues: issues, policyCount },
  );
};

const auditLog: EvidenceEvaluator = async (ctx) => {
  const where = and(
    eq(auditLogs.organizationId, ctx.organizationId),
    inPeriod(auditLogs.createdAt, ctx),
  );
  const [[total], rows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(where),
    db
      .select({
        createdAt: auditLogs.createdAt,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        userId: auditLogs.userId,
        apiKeyId: auditLogs.apiKeyId,
        ipAddress: auditLogs.ipAddress,
        userName: users.displayName,
        userEmail: users.email,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.userId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(MAX_EVIDENCE_ROWS),
  ]);
  const totalCount = total?.count ?? 0;
  const actors = new Set(
    rows.map((r) => r.userId ?? (r.apiKeyId ? `key:${r.apiKeyId}` : null)).filter(Boolean),
  );
  const byAction = new Map<string, number>();
  for (const r of rows) byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
  const top = [...byAction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return build(
    "audit-log",
    totalCount === 0 ? "no-data" : "present",
    totalCount === 0
      ? "No audited changes were recorded during the period."
      : `${totalCount} audited change(s) by ${actors.size} actor(s) during the period.`,
    [
      m("entries", "Entries in period", totalCount),
      m("actors", "Distinct actors", actors.size),
      m("included", "Entries included in this pack", rows.length),
      m(
        "topActions",
        "Most frequent actions",
        top.map(([a, n]) => `${a} (${n})`).join(", ") || null,
      ),
    ],
    [],
    rows.length,
    toComplianceCsv(
      [
        "Time",
        "Actor",
        "Actor email",
        "API key",
        "Action",
        "Entity type",
        "Entity id",
        "IP address",
      ],
      rows.map((r) => [
        r.createdAt.toISOString(),
        r.userName ?? r.userId,
        r.userEmail,
        r.apiKeyId,
        r.action,
        r.entityType,
        r.entityId,
        r.ipAddress,
      ]),
    ),
    { totalCount, entries: rows },
  );
};

const changeTimeline: EvidenceEvaluator = async (ctx) => {
  const where = and(
    eq(resourceChanges.organizationId, ctx.organizationId),
    inPeriod(resourceChanges.createdAt, ctx),
  );
  const [kinds, rows] = await Promise.all([
    db
      .select({ kind: resourceChanges.changeKind, count: sql<number>`count(*)::int` })
      .from(resourceChanges)
      .where(where)
      .groupBy(resourceChanges.changeKind),
    db
      .select({
        createdAt: resourceChanges.createdAt,
        changeKind: resourceChanges.changeKind,
        displayName: resourceChanges.displayName,
        resourceId: resourceChanges.resourceId,
        resourceTypeId: resourceChanges.resourceTypeId,
        pluginId: resourceChanges.pluginId,
        accountId: resourceChanges.accountId,
        diff: resourceChanges.diff,
        revertedAt: resourceChanges.revertedAt,
      })
      .from(resourceChanges)
      .where(where)
      .orderBy(desc(resourceChanges.createdAt))
      .limit(MAX_EVIDENCE_ROWS),
  ]);
  const byKind = { created: 0, updated: 0, deleted: 0 } as Record<string, number>;
  for (const k of kinds) byKind[k.kind] = k.count;
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  const reverted = rows.filter((r) => r.revertedAt !== null).length;
  return build(
    "change-timeline",
    total === 0 ? "no-data" : "present",
    total === 0
      ? "No resource changes were recorded during the period."
      : `${total} resource change(s) recorded: ${byKind["created"]} created, ${byKind["updated"]} changed, ${byKind["deleted"]} deleted.`,
    [
      m("total", "Changes in period", total),
      m("created", "Created", byKind["created"] ?? 0),
      m("updated", "Changed", byKind["updated"] ?? 0),
      m("deleted", "Deleted", byKind["deleted"] ?? 0),
      m("reverted", "Reverted through Infrawrench", reverted),
      m("retention", "Feed retention (days)", 90),
    ],
    [],
    rows.length,
    toComplianceCsv(
      [
        "Time",
        "Kind",
        "Resource",
        "Resource id",
        "Type",
        "Plugin",
        "Account id",
        "Fields changed",
        "Reverted at",
      ],
      rows.map((r) => [
        r.createdAt.toISOString(),
        r.changeKind,
        r.displayName,
        r.resourceId,
        r.resourceTypeId,
        r.pluginId,
        r.accountId,
        (r.diff ?? []).map((d) => d.field).join(", "),
        iso(r.revertedAt),
      ]),
    ),
    { counts: byKind, changes: rows },
  );
};

const changeFreezesSource: EvidenceEvaluator = async (ctx) => {
  // A freeze counts when it overlapped the period at all, not only when it
  // started inside it: a freeze opened the day before still governed it.
  const rows = await db
    .select({
      id: changeFreezes.id,
      name: changeFreezes.name,
      reason: changeFreezes.reason,
      startsAt: changeFreezes.startsAt,
      endsAt: changeFreezes.endsAt,
      active: changeFreezes.active,
      createdByName: users.displayName,
      createdAt: changeFreezes.createdAt,
    })
    .from(changeFreezes)
    .leftJoin(users, eq(users.id, changeFreezes.createdByUserId))
    .where(
      and(
        eq(changeFreezes.organizationId, ctx.organizationId),
        lt(changeFreezes.startsAt, ctx.end),
        or(isNull(changeFreezes.endsAt), gte(changeFreezes.endsAt, ctx.start)),
      ),
    )
    .orderBy(desc(changeFreezes.startsAt))
    .limit(MAX_EVIDENCE_ROWS);
  return build(
    "change-freezes",
    rows.length === 0 ? "no-data" : "present",
    rows.length === 0
      ? "No change freezes were in effect during the period."
      : `${rows.length} change freeze(s) in effect during the period.`,
    [
      m("freezes", "Freezes in period", rows.length),
      m("active", "Active now", rows.filter((r) => r.active).length),
    ],
    [],
    rows.length,
    toComplianceCsv(
      ["Name", "Reason", "Starts", "Ends", "Active", "Opened by"],
      rows.map((r) => [
        r.name,
        r.reason,
        r.startsAt.toISOString(),
        iso(r.endsAt),
        r.active ? "yes" : "no",
        r.createdByName,
      ]),
    ),
    rows,
  );
};

const sessionRecordings: EvidenceEvaluator = async (ctx) => {
  const [settings, rows] = await Promise.all([
    getSessionRecordingSettings(ctx.organizationId),
    db
      .select({
        id: sshSessionRecordings.id,
        userName: sshSessionRecordings.userName,
        host: sshSessionRecordings.host,
        username: sshSessionRecordings.username,
        resourceId: sshSessionRecordings.resourceId,
        status: sshSessionRecordings.status,
        hasInput: sshSessionRecordings.hasInput,
        startedAt: sshSessionRecordings.startedAt,
        endedAt: sshSessionRecordings.endedAt,
      })
      .from(sshSessionRecordings)
      .where(
        and(
          eq(sshSessionRecordings.organizationId, ctx.organizationId),
          inPeriod(sshSessionRecordings.startedAt, ctx),
        ),
      )
      .orderBy(desc(sshSessionRecordings.startedAt))
      .limit(MAX_EVIDENCE_ROWS),
  ]);
  const truncated = rows.filter((r) => r.status === "truncated").length;
  const gaps: string[] = [];
  if (!settings.enabled) gaps.push("Session recording is switched off");
  if (settings.enabled && settings.retentionDays < 90) {
    gaps.push(
      `Recordings are kept for ${settings.retentionDays} day(s), less than a typical 90-day audit window`,
    );
  }
  const status: EvidenceStatus =
    !settings.enabled && rows.length === 0 ? "gap" : gaps.length > 0 ? "gap" : "present";
  return build(
    "session-recordings",
    status,
    settings.enabled
      ? `Recording on, kept ${settings.retentionDays} day(s); ${rows.length} session(s) recorded during the period.`
      : `Recording is off; ${rows.length} session(s) recorded during the period.`,
    [
      m("enabled", "Recording enabled", settings.enabled ? "yes" : "no"),
      m("captureInput", "Input captured", settings.captureInput ? "yes" : "no"),
      m("retentionDays", "Retention (days)", settings.retentionDays),
      m("sessions", "Sessions in period", rows.length),
      m("truncated", "Truncated at the size cap", truncated),
    ],
    gaps,
    rows.length,
    toComplianceCsv(
      [
        "Started",
        "Ended",
        "Member",
        "Host",
        "Login",
        "Resource id",
        "Status",
        "Input captured",
        "Recording id",
      ],
      rows.map((r) => [
        r.startedAt.toISOString(),
        iso(r.endedAt),
        r.userName,
        r.host,
        r.username,
        r.resourceId,
        r.status,
        r.hasInput ? "yes" : "no",
        r.id,
      ]),
    ),
    { settings, sessions: rows },
  );
};

const incidentsSource: EvidenceEvaluator = async (ctx) => {
  // Overlap, like freezes: an incident that started before the period and
  // resolved inside it is part of the period's story.
  const rows = await db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.organizationId, ctx.organizationId),
        lt(incidents.startedAt, ctx.end),
        or(isNull(incidents.resolvedAt), gte(incidents.resolvedAt, ctx.start)),
      ),
    )
    .orderBy(desc(incidents.startedAt))
    .limit(MAX_EVIDENCE_ROWS);
  const ids = rows.map((r) => r.id);
  const noteCounts = new Map<string, number>();
  if (ids.length > 0) {
    const counts = await db
      .select({ incidentId: incidentNotes.incidentId, count: sql<number>`count(*)::int` })
      .from(incidentNotes)
      .where(inArray(incidentNotes.incidentId, ids))
      .groupBy(incidentNotes.incidentId);
    for (const c of counts) noteCounts.set(c.incidentId, c.count);
  }
  const resolved = rows.filter((r) => r.resolvedAt !== null);
  // A written follow-up is a linked issue or at least one timeline note. The
  // postmortem itself is generated on demand from the timeline, so what an
  // auditor can check is that somebody recorded what happened and what
  // follows from it.
  const withoutFollowUp = resolved.filter((r) => !r.issueUrl && (noteCounts.get(r.id) ?? 0) === 0);
  const mitigate = rows
    .filter((r) => r.mitigatedAt)
    .map((r) => hours(r.mitigatedAt!.getTime() - r.startedAt.getTime()));
  const resolve = resolved.map((r) => hours(r.resolvedAt!.getTime() - r.startedAt.getTime()));
  const open = rows.filter((r) => r.status !== "resolved").length;
  const gaps =
    withoutFollowUp.length > 0
      ? [`${withoutFollowUp.length} resolved incident(s) have no notes or linked follow-up issue`]
      : [];
  return build(
    "incidents",
    rows.length === 0 ? "no-data" : gaps.length > 0 ? "gap" : "present",
    rows.length === 0
      ? "No incidents were declared during the period."
      : `${rows.length} incident(s) during the period, ${resolved.length} resolved, ${open} still open or mitigated.`,
    [
      m("incidents", "Incidents in period", rows.length),
      m("sev1", "Sev 1", rows.filter((r) => r.severity === "sev1").length),
      m("resolved", "Resolved", resolved.length),
      m("open", "Open or mitigated", open),
      m("medianMitigate", "Median hours to mitigate", medianOf(mitigate)),
      m("medianResolve", "Median hours to resolve", medianOf(resolve)),
      m("noFollowUp", "Resolved without a follow-up", withoutFollowUp.length),
    ],
    gaps,
    rows.length,
    toComplianceCsv(
      [
        "Started",
        "Title",
        "Severity",
        "Status",
        "Mitigated",
        "Resolved",
        "Hours to resolve",
        "Notes",
        "Follow-up issue",
        "Incident id",
      ],
      rows.map((r) => [
        r.startedAt.toISOString(),
        r.title,
        r.severity,
        r.status,
        iso(r.mitigatedAt),
        iso(r.resolvedAt),
        r.resolvedAt ? hours(r.resolvedAt.getTime() - r.startedAt.getTime()) : null,
        noteCounts.get(r.id) ?? 0,
        r.issueUrl,
        r.id,
      ]),
    ),
    rows.map((r) => ({ ...r, noteCount: noteCounts.get(r.id) ?? 0 })),
  );
};

/**
 * Leak list reads are capped per call (open leaks first), so an org with
 * more history than one read holds is read again per status. The total from
 * the counts is reported beside what was included, the audit log's rule.
 */
async function readAllLeaks(organizationId: string) {
  const first = await listLeakedSecrets(organizationId);
  const total = LEAKED_SECRET_STATUSES.reduce((n, s) => n + first.counts[s], 0);
  if (first.leaks.length >= total) return { ...first, total };
  const byId = new Map<string, LeakedSecret>(first.leaks.map((l) => [l.id, l]));
  const perStatus = await Promise.all(
    LEAKED_SECRET_STATUSES.map((status) => listLeakedSecrets(organizationId, { status })),
  );
  for (const read of perStatus) for (const l of read.leaks) byId.set(l.id, l);
  return { ...first, leaks: [...byId.values()], total };
}

const leakedCredentials: EvidenceEvaluator = async (ctx) => {
  const read = await readAllLeaks(ctx.organizationId);
  const summary = summarizeLeakedCredentialEvidence(
    read,
    { start: ctx.start.getTime(), end: ctx.end.getTime() },
    ctx.now.getTime(),
  );
  const gaps = leakedCredentialEvidenceGaps(summary);
  const { records: _records, ...figures } = summary;
  const metrics: EvidenceMetric[] = [
    m("scanners", "Connected secret scanners", summary.scannerCount),
    m("opened", "Detected in period", summary.opened),
    m("rotated", "Rotated in period", summary.rotated),
    m("dismissed", "Dismissed in period", summary.dismissed),
  ];
  for (const [reason, label] of Object.entries(LEAK_DISMISS_REASON_LABELS)) {
    metrics.push(
      m(
        `dismissed:${reason}`,
        `Dismissed as ${label.toLowerCase()}`,
        summary.dismissedByReason[reason as keyof typeof summary.dismissedByReason],
      ),
    );
  }
  metrics.push(
    m("resolvedUpstream", "Resolved on the scanner", summary.resolvedUpstream),
    m(
      "closedUpstream",
      "Closed on the scanner by Infrawrench",
      summary.closedUpstreamByInfrawrench,
    ),
    m("medianRotate", "Median hours from detection to rotation", summary.medianHoursToRotate),
    m("maxRotate", "Longest hours from detection to rotation", summary.maxHoursToRotate),
    m("openNow", "Open at generation time", summary.openNow),
    m(
      "overdue",
      `Open longer than the ${summary.targetHours}-hour target`,
      summary.overdueCritical,
    ),
    m("openPublic", "Open and found in a public place", summary.openPublic),
  );
  if (read.leaks.length < read.total) {
    metrics.push(m("included", "Leaks read (of total)", `${read.leaks.length} of ${read.total}`));
  }
  const noData = summary.scannerCount === 0 && summary.records.length === 0;
  return build(
    "leaked-credentials",
    noData ? "no-data" : gaps.length > 0 ? "gap" : "present",
    noData
      ? "No secret scanner is connected."
      : `${summary.opened} leak(s) detected during the period, ${summary.rotated} rotated and ${summary.dismissed} dismissed; ${summary.openNow} open at generation time.`,
    metrics,
    gaps,
    summary.records.length,
    toComplianceCsv(
      [
        "Status",
        "Severity",
        "Token type",
        "Issuer",
        "Scanner account",
        "Repository",
        "Path",
        "Line",
        "Commit",
        "Validity",
        "Public",
        "Detected",
        "First seen",
        "Matched account",
        "Matched resource",
        "Match confidence",
        "Rotated at",
        "Rotated by",
        "Rotation method",
        "Hours to rotate",
        "Dismissed at",
        "Dismissed by",
        "Dismiss reason",
        "Dismiss comment",
        "Closed on scanner at",
        "Scanner resolution",
        "Finding URL",
      ],
      summary.records.map((r) => [
        r.status,
        r.severity,
        r.tokenTypeLabel,
        r.ownerPluginName,
        r.scannerAccountName,
        r.repository,
        r.path,
        r.line,
        r.commitSha,
        r.validity,
        r.publiclyLeaked ? "yes" : "no",
        r.detectedAt,
        r.firstSeenAt,
        r.matchedAccountName,
        r.matchedResourceName,
        r.matchConfidence,
        r.rotatedAt,
        r.rotatedBy,
        r.rotationMethod,
        r.hoursToRotate,
        r.dismissedAt,
        r.dismissedBy,
        r.dismissedReason ? LEAK_DISMISS_REASON_LABELS[r.dismissedReason] : null,
        r.dismissedComment,
        r.upstreamResolvedAt,
        r.upstreamResolution,
        r.url,
      ]),
    ),
    // The JSON carries the whitelisted records only, never the wire leaks:
    // those include the masked hint.
    {
      summary: figures,
      scanners: read.scanners.map((s) => ({
        accountName: s.accountName,
        pluginId: s.pluginId,
        label: s.label,
        lastScannedAt: s.lastScannedAt,
        lastError: s.lastError,
      })),
      leaks: summary.records,
      totalLeaks: read.total,
    },
  );
};

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

const evaluators = new Map<EvidenceSourceId, EvidenceEvaluator>([
  ["access-review", accessReview],
  ["jit-access", jitAccess],
  ["audit-log", auditLog],
  ["posture", posture],
  ["vulnerabilities", vulnerabilities],
  ["backup-coverage", backupCoverage],
  ["restore-drills", restoreDrillsSource],
  ["change-timeline", changeTimeline],
  ["change-freezes", changeFreezesSource],
  ["session-recordings", sessionRecordings],
  ["incidents", incidentsSource],
  ["scorecards", scorecardsSource],
  ["leaked-credentials", leakedCredentials],
]);

/**
 * Extension point: register (or replace) the evaluator for a source id. See
 * the module note for the three edits a new source needs.
 */
export function registerEvidenceEvaluator(
  id: EvidenceSourceId,
  evaluator: EvidenceEvaluator,
): void {
  evaluators.set(id, evaluator);
}

export function getEvidenceEvaluator(id: EvidenceSourceId): EvidenceEvaluator | undefined {
  return evaluators.get(id);
}

export function registeredEvidenceSourceIds(): EvidenceSourceId[] {
  return [...evaluators.keys()];
}
