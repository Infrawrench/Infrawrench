/**
 * Pure capping and rendering for posture alerts. No I/O lives here so the
 * message shape is unit-testable without a database — the same split as
 * `expiry/summary.ts`. `alerts.ts` does the claim, the feed read and the
 * fan-out.
 *
 * Only critical and high findings reach a message: medium/low findings are
 * hygiene work for the Posture screen, not something to page a channel about.
 * Volume is structurally bounded before this module runs: the cooldown claim
 * caps the message rate at one per org per 24h, and the feed itself is one
 * bounded computation over stored rows. What this module bounds is the *body*
 * — at most {@link MAX_LISTED_FINDINGS} named findings, worst first, with the
 * rest collapsed into a trailing count.
 */
import type { PostureFinding, PostureSeverity } from "@infrawrench/client-core";
import { escapeMrkdwnFragment } from "../slack-escape";

/** Hard ceiling on individual findings named in the message body. */
export const MAX_LISTED_FINDINGS = 8;

/** The alertable severities, worst first. Medium/low never reach a message. */
export const POSTURE_ALERT_SEVERITIES = ["critical", "high"] as const;

export type PostureAlertSeverity = (typeof POSTURE_ALERT_SEVERITIES)[number];

export interface PostureAlertSummary {
  /** Alertable findings (severity critical or high). */
  total: number;
  /** Count per alertable severity; every bucket present, zeros included. */
  counts: Record<PostureAlertSeverity, number>;
  /** The findings named in the body — the worst, capped. */
  findings: PostureFinding[];
  /** How many findings the body does not name. */
  omitted: number;
}

/**
 * Fold the alertable findings into the message the transports render.
 * `findings` must already be filtered to critical/high (see
 * `alertablePostureFindings`) and sorted worst first, which is the feed's own
 * order.
 */
export function summarizePosture(findings: PostureFinding[]): PostureAlertSummary {
  const counts: Record<PostureAlertSeverity, number> = { critical: 0, high: 0 };
  for (const finding of findings) {
    if (finding.severity === "critical" || finding.severity === "high") {
      counts[finding.severity] += 1;
    }
  }
  return {
    total: findings.length,
    counts,
    findings: findings.slice(0, MAX_LISTED_FINDINGS),
    omitted: Math.max(0, findings.length - MAX_LISTED_FINDINGS),
  };
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** Message headline. */
export function postureTitle(summary: PostureAlertSummary): string {
  if (summary.counts.critical > 0) {
    return `Posture checks: ${plural(summary.counts.critical, "critical finding")}, ${
      summary.counts.high
    } high`;
  }
  return `Posture checks: ${plural(summary.total, "high-severity finding")}`;
}

/**
 * `"<name> — <title> (critical)"`.
 *
 * `displayName` is synced from the customer's cloud, so a transport that
 * interprets markup has to be handed an `escape` that neutralises it — a
 * resource called `~assets~` would otherwise render struck through, which is
 * what "already dealt with" looks like. The default is identity, for the
 * plain-text transports.
 */
export function postureFindingLine(
  finding: PostureFinding,
  escape: (s: string) => string = (s) => s,
): string {
  return `${escape(finding.displayName)} — ${finding.title} (${finding.severity})`;
}

function countsLine(summary: PostureAlertSummary): string {
  return POSTURE_ALERT_SEVERITIES.map((s) => `${summary.counts[s]} ${s}`).join(" · ");
}

/**
 * The body as plain-text lines, shared by every transport — the same split
 * the drift and expiry bodies use. `bold` wraps a fragment in the transport's
 * bold markup, or returns it unchanged for plain text (the Teams Adaptive
 * Card escaper turns `*` into a literal asterisk, so Teams must not receive
 * mrkdwn).
 */
export function postureLines(
  summary: PostureAlertSummary,
  bold: (s: string) => string,
  escape: (s: string) => string = (s) => s,
): string[] {
  const lines: string[] = [
    `${bold(plural(summary.total, "security finding"))} on synced resources`,
    countsLine(summary),
  ];
  if (summary.findings.length > 0) {
    lines.push("");
    for (const finding of summary.findings) lines.push(`• ${postureFindingLine(finding, escape)}`);
  }
  if (summary.omitted > 0) {
    lines.push(`…and ${plural(summary.omitted, "more finding")} on the posture screen`);
  }
  return lines;
}

/** Slack mrkdwn body. `slack.ts` escapes `&<>` and leaves `*bold*` intact. */
export function formatPostureSlackBody(summary: PostureAlertSummary): string {
  return postureLines(summary, (s) => `*${s}*`, escapeMrkdwnFragment).join("\n");
}

/** Teams plain-text body — the Adaptive Card escaper strips markdown anyway. */
export function formatPostureTeamsBody(summary: PostureAlertSummary): string {
  // The "\n\n" join already separates paragraphs; the empty spacer line the
  // Slack body wants would double up here.
  return postureLines(summary, (s) => s)
    .filter((line) => line !== "")
    .join("\n\n");
}

/**
 * Mobile push body. A notification banner shows two or three lines, so it
 * gets the counts and the single worst finding — the deep link carries the
 * reader to the full screen.
 */
export function formatPosturePushBody(summary: PostureAlertSummary): string {
  const first = summary.findings[0];
  const lead = first ? `${postureFindingLine(first)}. ` : "";
  return `${lead}${countsLine(summary)}`;
}

/** Slack/Teams context line. */
export function postureContext(): string {
  return "critical & high findings · plugin-declared checks over synced resources";
}

/** Type used by tests to keep the severity math honest. */
export type { PostureSeverity };
