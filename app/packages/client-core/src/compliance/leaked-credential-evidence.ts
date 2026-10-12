/**
 * The leaked-credential evidence, computed purely from the leak list so it
 * is testable without a database.
 *
 * Three questions an auditor asks of secret handling, each answered from
 * data the product already holds:
 * - Is anyone looking? (the connected scanners and whether their last read
 *   worked)
 * - What leaked during the period, and what happened to each one? (opened,
 *   rotated, dismissed with its reason, resolved on the scanner)
 * - How fast is a leaked credential rotated? (detection to rotation, and
 *   what is still open past {@link LEAKED_CREDENTIAL_ROTATION_TARGET_HOURS})
 *
 * {@link toLeakedCredentialEvidenceRecord} is the only shape that reaches a
 * pack. It is a whitelist on purpose: the wire shape carries the masked
 * `secretHint`, and an evidence file is handed to people outside the org, so
 * no part of a secret, masked or not, is ever copied into one.
 */
import {
  leakSeverity,
  type LeakDismissReason,
  type LeakRotationMethod,
  type LeakedSecret,
  type LeakedSecretMatchConfidence,
  type LeakedSecretMatchKind,
  type LeakedSecretScanner,
  type LeakedSecretStatus,
} from "../leaked-secrets";

const HOUR_MS = 3_600_000;

/**
 * Hours a critical leak may stay open after Infrawrench first saw it before
 * the evidence counts it as overdue. A common target for exposed
 * credentials, not a framework requirement; printed beside the figures.
 */
export const LEAKED_CREDENTIAL_ROTATION_TARGET_HOURS = 24;

/** One leak as an evidence pack carries it. Never the value, never the hint. */
export interface LeakedCredentialEvidenceRecord {
  id: string;
  status: LeakedSecretStatus;
  severity: "critical" | "high";
  tokenType: string;
  tokenTypeLabel: string;
  ownerPluginName: string | null;
  scannerAccountName: string;
  repository: string | null;
  path: string | null;
  line: number | null;
  commitSha: string | null;
  url: string | null;
  validity: LeakedSecret["validity"];
  publiclyLeaked: boolean;
  /** When the scanner detected it. */
  detectedAt: string;
  /** When Infrawrench first saw it. */
  firstSeenAt: string;
  matchKind: LeakedSecretMatchKind;
  matchConfidence: LeakedSecretMatchConfidence;
  matchedAccountName: string | null;
  matchedResourceName: string | null;
  rotatedAt: string | null;
  rotatedBy: string | null;
  rotationMethod: LeakRotationMethod | null;
  /** Detection to rotation; null unless rotated. */
  hoursToRotate: number | null;
  dismissedAt: string | null;
  dismissedBy: string | null;
  dismissedReason: LeakDismissReason | null;
  dismissedComment: string | null;
  upstreamResolution: string | null;
  /** When Infrawrench closed the finding on the scanner. */
  upstreamResolvedAt: string | null;
}

export interface LeakedCredentialEvidenceSummary {
  scannerCount: number;
  /** Scanners whose most recent read failed. */
  failingScanners: number;
  /** Still open at generation time, whenever they were detected. */
  openNow: number;
  openCritical: number;
  /** Open critical leaks first seen longer ago than the rotation target. */
  overdueCritical: number;
  openPublic: number;
  /** Detected during the period. */
  opened: number;
  rotated: number;
  dismissed: number;
  dismissedByReason: Record<LeakDismissReason, number>;
  /** Closed on the scanner by someone else (status `resolved`). */
  resolvedUpstream: number;
  /** Closed on the scanner by Infrawrench during the period. */
  closedUpstreamByInfrawrench: number;
  medianHoursToRotate: number | null;
  maxHoursToRotate: number | null;
  targetHours: number;
  /** The leaks the pack lists: every open one plus any with activity in the period. */
  records: LeakedCredentialEvidenceRecord[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return round1(sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
}

function hoursBetween(from: string, to: string | null): number | null {
  if (!to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? round1(Math.max(0, ms) / HOUR_MS) : null;
}

/** The pack's projection of a leak. A whitelist: `secretHint` is never copied. */
export function toLeakedCredentialEvidenceRecord(
  leak: LeakedSecret,
): LeakedCredentialEvidenceRecord {
  return {
    id: leak.id,
    status: leak.status,
    severity: leakSeverity(leak),
    tokenType: leak.tokenType,
    tokenTypeLabel: leak.tokenTypeLabel,
    ownerPluginName: leak.ownerPluginName,
    scannerAccountName: leak.scannerAccountName,
    repository: leak.repository,
    path: leak.path,
    line: leak.line,
    commitSha: leak.commitSha,
    url: leak.url,
    validity: leak.validity,
    publiclyLeaked: leak.publiclyLeaked,
    detectedAt: leak.detectedAt,
    firstSeenAt: leak.firstSeenAt,
    matchKind: leak.matchKind,
    matchConfidence: leak.matchConfidence,
    matchedAccountName: leak.matchedAccountName,
    matchedResourceName: leak.matchedResourceName,
    rotatedAt: leak.rotatedAt,
    rotatedBy: leak.rotatedBy,
    rotationMethod: leak.rotationMethod,
    hoursToRotate: leak.status === "rotated" ? hoursBetween(leak.detectedAt, leak.rotatedAt) : null,
    dismissedAt: leak.dismissedAt,
    dismissedBy: leak.dismissedBy,
    dismissedReason: leak.dismissedReason,
    dismissedComment: leak.dismissedComment,
    upstreamResolution: leak.upstreamResolution,
    upstreamResolvedAt: leak.upstreamResolvedAt,
  };
}

export function summarizeLeakedCredentialEvidence(
  input: { leaks: readonly LeakedSecret[]; scanners: readonly LeakedSecretScanner[] },
  period: { start: number; end: number },
  now: number,
): LeakedCredentialEvidenceSummary {
  const inPeriod = (at: string | null) => {
    if (!at) return false;
    const t = Date.parse(at);
    return t >= period.start && t < period.end;
  };
  const summary: LeakedCredentialEvidenceSummary = {
    scannerCount: input.scanners.length,
    failingScanners: input.scanners.filter((s) => s.lastError !== null).length,
    openNow: 0,
    openCritical: 0,
    overdueCritical: 0,
    openPublic: 0,
    opened: 0,
    rotated: 0,
    dismissed: 0,
    dismissedByReason: { "false-positive": 0, "used-in-tests": 0, "wont-fix": 0 },
    resolvedUpstream: 0,
    closedUpstreamByInfrawrench: 0,
    medianHoursToRotate: null,
    maxHoursToRotate: null,
    targetHours: LEAKED_CREDENTIAL_ROTATION_TARGET_HOURS,
    records: [],
  };
  const rotateHours: number[] = [];

  for (const leak of input.leaks) {
    const detected = inPeriod(leak.detectedAt);
    const rotated = leak.status === "rotated" && inPeriod(leak.rotatedAt);
    const dismissed = leak.status === "dismissed" && inPeriod(leak.dismissedAt);
    const closedUpstream = inPeriod(leak.upstreamResolvedAt);
    // A leak resolved on the scanner by someone else carries no time of its
    // own, so it is placed by when it was detected.
    const resolvedUpstream = leak.status === "resolved" && detected;
    const open = leak.status === "open";
    if (detected) summary.opened++;
    if (open) {
      summary.openNow++;
      if (leak.publiclyLeaked) summary.openPublic++;
      if (leakSeverity(leak) === "critical") {
        summary.openCritical++;
        // The clock starts when Infrawrench first saw the leak, not when the
        // scanner detected it: a scanner connected today brings years of
        // history nobody here could have acted on.
        const seen = Date.parse(leak.firstSeenAt);
        if (!Number.isNaN(seen) && now - seen > LEAKED_CREDENTIAL_ROTATION_TARGET_HOURS * HOUR_MS) {
          summary.overdueCritical++;
        }
      }
    }
    if (rotated) {
      summary.rotated++;
      const hours = hoursBetween(leak.detectedAt, leak.rotatedAt);
      if (hours !== null) rotateHours.push(hours);
    }
    if (dismissed) {
      summary.dismissed++;
      if (leak.dismissedReason) summary.dismissedByReason[leak.dismissedReason]++;
    }
    if (resolvedUpstream) summary.resolvedUpstream++;
    if (closedUpstream) summary.closedUpstreamByInfrawrench++;
    if (open || detected || rotated || dismissed || closedUpstream) {
      summary.records.push(toLeakedCredentialEvidenceRecord(leak));
    }
  }
  summary.medianHoursToRotate = median(rotateHours);
  summary.maxHoursToRotate = rotateHours.length > 0 ? Math.max(...rotateHours) : null;
  return summary;
}

/**
 * Plain-language gaps: critical leaks open past the rotation target, and
 * scanners that stopped reporting. Leaks the scanner reports as inactive and
 * that match nothing Infrawrench holds are figures, not gaps (the
 * `leakSeverity` rule), and so is time to rotate: a slow rotation that did
 * happen is history, an open leak is exposure.
 */
export function leakedCredentialEvidenceGaps(summary: LeakedCredentialEvidenceSummary): string[] {
  const gaps: string[] = [];
  if (summary.overdueCritical > 0) {
    gaps.push(
      `${summary.overdueCritical} leaked credential(s) open longer than the ${summary.targetHours}-hour rotation target`,
    );
  }
  if (summary.failingScanners > 0) {
    gaps.push(`${summary.failingScanners} secret scanner(s) failed their most recent read`);
  }
  return gaps;
}
