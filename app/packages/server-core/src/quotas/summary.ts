/**
 * Pure capping and rendering for quota alerts. No I/O lives here so the
 * message shape is unit-testable without a database — the same split as
 * `expiry/summary.ts` and `drift/summary.ts`. `alerts.ts` does the claim, the
 * feed read and the fan-out.
 *
 * Volume is structurally bounded before this module runs: the cooldown claim
 * caps the message rate at one per org per 24h, and the feed is one bounded
 * read of stored rows. What this module bounds is the *body* — at most
 * {@link MAX_LISTED_QUOTAS} named quotas, worst first, with the rest collapsed
 * into a trailing count.
 */
import {
  formatDaysToExhaustion,
  formatQuotaAmount,
  formatQuotaUtilization,
  type QuotaRow,
  type QuotaSeverity,
} from "@infrawrench/client-core";

/** Hard ceiling on individual quotas named in the message body. */
export const MAX_LISTED_QUOTAS = 8;

/** The alertable severities, most urgent first. `ok` never reaches a message. */
export const QUOTA_ALERT_SEVERITIES = ["exhausted", "critical", "trending"] as const;

export type QuotaAlertSeverity = (typeof QUOTA_ALERT_SEVERITIES)[number];

export interface QuotaAlertSummary {
  /** Quotas at or heading for their limit (severity != "ok"). */
  total: number;
  /** Count per alertable severity; every bucket present, zeros included. */
  counts: Record<QuotaAlertSeverity, number>;
  /** The quotas named in the body — the worst, capped. */
  rows: QuotaRow[];
  /** How many quotas the body does not name. */
  omitted: number;
  /** The threshold the feed was bucketed against, as a fraction. */
  threshold: number;
}

/**
 * Fold the alertable rows into the message the transports render. `rows` must
 * already exclude `ok` (see `alertableQuotas`) and be in the feed's own
 * worst-first order.
 */
export function summarizeQuotas(rows: QuotaRow[], threshold: number): QuotaAlertSummary {
  const counts: Record<QuotaAlertSeverity, number> = {
    exhausted: 0,
    critical: 0,
    trending: 0,
  };
  for (const row of rows) {
    if (row.severity !== "ok") counts[row.severity as QuotaAlertSeverity] += 1;
  }
  return {
    total: rows.length,
    counts,
    rows: rows.slice(0, MAX_LISTED_QUOTAS),
    omitted: Math.max(0, rows.length - MAX_LISTED_QUOTAS),
    threshold,
  };
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

const SEVERITY_WORDS: Record<QuotaAlertSeverity, string> = {
  exhausted: "at the limit",
  critical: "over threshold",
  trending: "trending to exhaustion",
};

/**
 * Message headline.
 *
 * An exhausted quota leads, always. "3 quotas over threshold" next to a fourth
 * that is already refusing requests buries the only line that describes an
 * outage in progress.
 */
export function quotaTitle(summary: QuotaAlertSummary): string {
  if (summary.counts.exhausted > 0) {
    return `Quota radar: ${plural(summary.counts.exhausted, "quota")} at the limit, ${
      summary.total - summary.counts.exhausted
    } approaching`;
  }
  return `Quota radar: ${plural(summary.total, "quota")} past ${formatQuotaUtilization(
    summary.threshold,
  )} utilisation`;
}

/**
 * `"prod-aws · ec2 Running On-Demand Standard instances (eu-west-1) — 912 of
 * 1,024 vCPUs, 89%, full in 6 days"`.
 *
 * The absolute figures ride alongside the percentage because a percentage on
 * its own does not say whether the fix is a support ticket or a redeploy: 89%
 * of 1,024 vCPUs has 112 left to work with, 89% of 5 Elastic IPs has none.
 */
export function quotaRowLine(row: QuotaRow): string {
  const scope = row.region ? ` (${row.region})` : "";
  const amounts = `${formatQuotaAmount(row.used, row.unit)} of ${formatQuotaAmount(
    row.limit,
    row.unit,
  )}`;
  const trailer =
    row.trend.daysToExhaustion !== null
      ? `, full ${formatDaysToExhaustion(row.trend.daysToExhaustion)}`
      : "";
  return `${row.accountName} · ${row.service} ${row.name}${scope} — ${amounts}, ${formatQuotaUtilization(
    row.utilization,
  )}${trailer}`;
}

function countsLine(summary: QuotaAlertSummary): string {
  return QUOTA_ALERT_SEVERITIES.filter((s) => summary.counts[s] > 0)
    .map((s) => `${summary.counts[s]} ${SEVERITY_WORDS[s]}`)
    .join(" · ");
}

/**
 * The body as plain-text lines, shared by every transport — the same split the
 * expiry and weekly-digest bodies use. `bold` wraps a fragment in the
 * transport's bold markup, or returns it unchanged for plain text (the Teams
 * Adaptive Card escaper turns `*` into a literal asterisk, so Teams must not
 * receive mrkdwn).
 */
export function quotaLines(summary: QuotaAlertSummary, bold: (s: string) => string): string[] {
  const lines: string[] = [
    `${bold(plural(summary.total, "quota"))} at or heading for a provider limit`,
    countsLine(summary),
  ];
  if (summary.rows.length > 0) {
    lines.push("");
    for (const row of summary.rows) lines.push(`• ${quotaRowLine(row)}`);
  }
  if (summary.omitted > 0) {
    lines.push(`…and ${plural(summary.omitted, "more quota")} on the radar`);
  }
  return lines;
}

/** Slack mrkdwn body. `slack.ts` escapes `&<>` and leaves `*bold*` intact. */
export function formatQuotaSlackBody(summary: QuotaAlertSummary): string {
  return quotaLines(summary, (s) => `*${s}*`).join("\n");
}

/** Teams plain-text body — the Adaptive Card escaper strips markdown anyway. */
export function formatQuotaTeamsBody(summary: QuotaAlertSummary): string {
  return quotaLines(summary, (s) => s).join("\n\n");
}

/**
 * Mobile push body. A notification banner shows two or three lines, so it gets
 * the counts and the single worst quota — the deep link carries the reader to
 * the full radar.
 */
export function formatQuotaPushBody(summary: QuotaAlertSummary): string {
  const first = summary.rows[0];
  const lead = first ? `${quotaRowLine(first)}. ` : "";
  return `${lead}${countsLine(summary)}`;
}

/** Slack/Teams context line. */
export function quotaContext(summary: QuotaAlertSummary): string {
  return `${formatQuotaUtilization(summary.threshold)} threshold · readings from your providers' quota APIs`;
}

/** Type used by tests to keep the severity math honest. */
export type { QuotaSeverity };
