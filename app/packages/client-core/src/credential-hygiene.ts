/**
 * Credential hygiene — the platform-neutral client half.
 *
 * API keys nobody uses, SSH keys nothing references, and members holding write
 * permissions they never exercise. All of it derived from data the server
 * already holds; no provider call, nothing to configure.
 *
 * One thing every surface rendering this must carry through: **the audit log
 * only witnesses writes.** The report never draws a conclusion about a read
 * permission, and `permissionFindingsWithheld` is set when the org does not
 * yet have enough audit history for the unused-permission finding to mean
 * anything. Both are load-bearing — a governance report that overclaims is
 * worse than no report.
 *
 * Server contract: `/api/org/:orgId/credential-hygiene` (web
 * `api/routes/credential-hygiene.ts`), gated on `audit:read`.
 */
import type { CloudFetch } from "./fetch";

export type HygieneSeverity = "high" | "medium" | "low";

export type HygieneFindingKind =
  | "api_key_never_used"
  | "api_key_idle"
  | "api_key_expired_not_revoked"
  | "api_key_wildcard_scope"
  | "api_key_unused_scopes"
  | "ssh_key_never_used"
  | "ssh_key_idle"
  | "member_unused_permissions";

export interface HygieneFinding {
  /** Stable across runs, so a surface can remember what has been looked at. */
  id: string;
  kind: HygieneFindingKind;
  severity: HygieneSeverity;
  title: string;
  /** The evidence. */
  detail: string;
  /** What to do about it. */
  recommendation: string;
  entityType: "api-key" | "ssh-key" | "member";
  entityId: string;
  entityName: string;
  facts: Record<string, string | number | boolean | null>;
}

export interface HygieneReport {
  generatedAt: string;
  windowDays: number;
  /** Days of audit history the org actually has; null when it has none. */
  auditHistoryDays: number | null;
  /**
   * True when there was not enough audit history to judge unused permissions,
   * so those findings were withheld rather than guessed at.
   */
  permissionFindingsWithheld: boolean;
  findings: HygieneFinding[];
  counts: Record<HygieneSeverity | "total", number>;
}

export async function fetchHygieneReport(
  api: CloudFetch,
  orgId: string,
  windowDays?: number,
): Promise<HygieneReport | null> {
  const qs = windowDays ? `?windowDays=${windowDays}` : "";
  return api.org<HygieneReport>(orgId, `/credential-hygiene${qs}`);
}

/** Where a finding's "fix it" link should go, per surface. */
export function hygieneFindingSection(finding: HygieneFinding): string {
  switch (finding.entityType) {
    case "api-key":
      return "api-keys";
    case "ssh-key":
      return "ssh-keys";
    case "member":
      return "team";
  }
}

export const HYGIENE_SEVERITY_LABELS: Record<HygieneSeverity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/**
 * A one-line summary for a header or a digest.
 *
 * Deliberately says "clean" only when there is genuinely nothing, rather than
 * rounding a withheld finding down to a pass.
 */
export function summarizeHygiene(report: HygieneReport): string {
  if (report.counts.total === 0) {
    return report.permissionFindingsWithheld
      ? "No credential issues found — not enough audit history yet to judge unused permissions."
      : "No credential hygiene issues found.";
  }
  const parts: string[] = [];
  if (report.counts.high > 0) parts.push(`${report.counts.high} high`);
  if (report.counts.medium > 0) parts.push(`${report.counts.medium} medium`);
  if (report.counts.low > 0) parts.push(`${report.counts.low} low`);
  return `${report.counts.total} finding${report.counts.total === 1 ? "" : "s"} (${parts.join(", ")})`;
}
