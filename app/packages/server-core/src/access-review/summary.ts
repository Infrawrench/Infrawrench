/**
 * Pure capping and rendering for the access-review half of the security alert.
 * No I/O lives here, so the message shape is unit-testable without a database
 * — the same split `posture/summary.ts` and `expiry/summary.ts` use.
 *
 * **Access-review findings ride the posture alert rather than a channel of
 * their own.** They are the same kind of thing — a security finding recomputed
 * from synced state, suppressible by the same dismissal — they answer to the
 * same `/posture/settings` switch, and an org that wants one paged wants the
 * other. Two independent 24h claims would deliver two messages a day about one
 * review, and a second trigger would cost three schema columns, both webhook
 * maps, the push contract and every settings surface to say something the
 * existing one already says.
 *
 * Only critical and high findings reach a message: medium and low are review
 * work for the screen and the weekly digest, not something to page about at
 * 3am.
 */
import type { AccessFinding } from "@infrawrench/client-core";
import { escapeMrkdwnFragment } from "../slack-escape";
import type { PostureAlertSummary } from "../posture/summary";

/**
 * Hard ceiling on individual access findings named in the message body. Lower
 * than posture's eight: the access half is the second section of a message
 * that already has one, and the deep link is right there.
 */
export const MAX_LISTED_ACCESS_FINDINGS = 6;

/** The alertable severities, worst first. Medium/low never reach a message. */
export const ACCESS_ALERT_SEVERITIES = ["critical", "high"] as const;

export type AccessAlertSeverity = (typeof ACCESS_ALERT_SEVERITIES)[number];

export interface AccessAlertSummary {
  /** Alertable findings (severity critical or high). */
  total: number;
  /** Count per alertable severity; every bucket present, zeros included. */
  counts: Record<AccessAlertSeverity, number>;
  /** The findings named in the body — the worst, capped. */
  findings: AccessFinding[];
  /** How many findings the body does not name. */
  omitted: number;
}

/**
 * Fold the alertable findings into the message the transports render.
 * `findings` must already be filtered to critical/high (see
 * `alertableAccessFindings`) and sorted worst first, which is the feed's own
 * order.
 */
export function summarizeAccessReview(findings: AccessFinding[]): AccessAlertSummary {
  const counts: Record<AccessAlertSeverity, number> = { critical: 0, high: 0 };
  for (const finding of findings) {
    if (finding.severity === "critical" || finding.severity === "high") {
      counts[finding.severity] += 1;
    }
  }
  return {
    total: findings.length,
    counts,
    findings: findings.slice(0, MAX_LISTED_ACCESS_FINDINGS),
    omitted: Math.max(0, findings.length - MAX_LISTED_ACCESS_FINDINGS),
  };
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/**
 * Every fragment of a finding line that came out of the customer's cloud, in
 * render order. Nothing else in a line is attacker-influenced: the title, the
 * severity and the punctuation are ours.
 */
function untrustedFragments(finding: AccessFinding): [string, string] {
  return [finding.principal.displayName, finding.principal.accountName];
}

/**
 * `"<principal> (<account>) — <title> (high)"`. The account is in the line
 * because a principal named `deploy` exists in most of them.
 *
 * **Both names are synced from the customer's cloud**, so a transport that
 * interprets markup has to be handed an `escape` that neutralises them — see
 * `escapeMrkdwnFragment`. The default is identity, for the plain-text
 * transports (Teams strips markdown in its Adaptive Card escaper; a push
 * banner renders none).
 */
export function accessFindingLine(
  finding: AccessFinding,
  escape: (s: string) => string = (s) => s,
): string {
  const [principal, account] = untrustedFragments(finding);
  return `${escape(principal)} (${escape(account)}) — ${finding.title} (${finding.severity})`;
}

/**
 * The access-review block as plain-text lines. `bold` wraps a fragment in the
 * transport's bold markup, or returns it unchanged for plain text (the Teams
 * Adaptive Card escaper turns `*` into a literal asterisk). `escape`
 * neutralises the synced names for transports that interpret markup.
 */
export function accessReviewLines(
  summary: AccessAlertSummary,
  bold: (s: string) => string,
  escape: (s: string) => string = (s) => s,
): string[] {
  const lines: string[] = [
    `${bold(plural(summary.total, "access finding"))} on cloud principals`,
    ACCESS_ALERT_SEVERITIES.map((s) => `${summary.counts[s]} ${s}`).join(" · "),
  ];
  if (summary.findings.length > 0) {
    lines.push("");
    for (const finding of summary.findings) lines.push(`• ${accessFindingLine(finding, escape)}`);
  }
  if (summary.omitted > 0) {
    lines.push(`…and ${plural(summary.omitted, "more finding")} on the access review`);
  }
  return lines;
}

/**
 * Headline for a window where only the access review found something, and the
 * combined headline where both did.
 *
 * The two are one function so the "posture only" case can stay with
 * `postureTitle` untouched: this exists to stop a message that says "Posture
 * checks: 0 high-severity findings" when the only thing found was a wildcard
 * role nobody has used since March.
 */
export function securityAlertTitle(
  posture: PostureAlertSummary,
  access: AccessAlertSummary,
): string | null {
  if (access.total === 0) return null;
  if (posture.total === 0) {
    if (access.counts.critical > 0) {
      return `Access review: ${plural(access.counts.critical, "critical finding")}, ${
        access.counts.high
      } high`;
    }
    return `Access review: ${plural(access.total, "high-severity finding")}`;
  }
  return `Security findings: ${plural(posture.total, "posture finding")}, ${plural(
    access.total,
    "access finding",
  )}`;
}

/**
 * The blocks joined into one body. Empty blocks are dropped rather than left
 * as a blank paragraph, so a window with only one half — or one whose access
 * half failed — still reads as one message.
 */
export function joinSecurityBody(blocks: readonly string[]): string {
  return blocks.filter((b) => b !== "").join("\n\n");
}

/**
 * The caveat appended when the access half of a security window threw but the
 * posture half had something to say. The message still goes out; it must not
 * read as a complete picture (the unknown-versus-clean distinction the review
 * keeps everywhere else).
 */
export const ACCESS_REVIEW_UNAVAILABLE_NOTE =
  "The access review could not be computed for this scan; only posture findings are listed.";

/** Slack mrkdwn body for the access-review block. */
export function formatAccessReviewSlackBody(summary: AccessAlertSummary): string {
  return accessReviewLines(summary, (s) => `*${s}*`, escapeMrkdwnFragment).join("\n");
}

/** Teams plain-text body for the access-review block. */
export function formatAccessReviewTeamsBody(summary: AccessAlertSummary): string {
  return accessReviewLines(summary, (s) => s)
    .filter((line) => line !== "")
    .join("\n\n");
}

/**
 * Mobile push body for a window whose only findings are access findings. A
 * notification banner shows two or three lines, so it gets the counts and the
 * single worst finding.
 */
export function formatAccessReviewPushBody(summary: AccessAlertSummary): string {
  const first = summary.findings[0];
  const lead = first ? `${accessFindingLine(first)}. ` : "";
  return `${lead}${ACCESS_ALERT_SEVERITIES.map((s) => `${summary.counts[s]} ${s}`).join(" · ")}`;
}
